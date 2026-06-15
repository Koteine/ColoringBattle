import express from 'express';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = '/data/uploads';
const DB_PATH = '/data/game.db';
const OWNER_TG_ID = '341995937';
const ADMIN_TG_IDS = new Set([OWNER_TG_ID]);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
const db = new sqlite3.Database(DB_PATH);
db.serialize();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const tgId = String(req.body.tg_id || 'unknown').replace(/[^0-9]/g, '') || 'unknown';
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${tgId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Можно загружать только картинки'));
    cb(null, true);
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER,
    tg_id TEXT PRIMARY KEY,
    username TEXT DEFAULT '',
    current_cell INTEGER DEFAULT 0,
    is_approved INTEGER DEFAULT 0,
    dice_frozen INTEGER DEFAULT 0,
    pending_lucky_cell INTEGER DEFAULT NULL,
    role TEXT DEFAULT 'user'
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_task TEXT NOT NULL
  )`);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_text_task ON tasks(text_task)');

  await run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    cell INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    image_name TEXT,
    photo_before TEXT,
    photo_after TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    admin_comment TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tg_id) REFERENCES users(tg_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`);

  await ensureSubmissionPhotoColumns();
  await ensureUserLuckyColumn();
  await ensureAccumulatingTicketsTable();
  await ensureRaffleConfigTable();
  await ensureRaffleResultsTable();
  await ensureNewsEventsTable();

  await run('CREATE INDEX IF NOT EXISTS idx_submissions_player_status ON submissions(tg_id, status, task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_pending_images ON submissions(status, image_name)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_pending_photos ON submissions(status, photo_before, photo_after)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_tg_id ON tickets(tg_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_status_random ON tickets(status, ticket_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_raffle_results_place ON raffle_results(place_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_raffle_results_ticket ON raffle_results(ticket_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_news_events_created ON news_events(created_at, id)');

  await run('DELETE FROM users WHERE tg_id = 391995937');

  await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role)
    VALUES (?, 'Owner', 0, 1, 0, 'admin')
    ON CONFLICT(tg_id) DO UPDATE SET
      username = CASE WHEN users.username = '' THEN 'Owner' ELSE users.username END,
      current_cell = 0,
      dice_frozen = 0,
      pending_lucky_cell = NULL,
      is_approved = 1,
      role = 'admin'`, [OWNER_TG_ID]);

  await seedTasks();
}

async function ensureUserLuckyColumn() {
  const columns = await all('PRAGMA table_info(users)');
  if (!columns.some((column) => column.name === 'pending_lucky_cell')) {
    await run('ALTER TABLE users ADD COLUMN pending_lucky_cell INTEGER DEFAULT NULL');
  }
}

async function ensureSubmissionPhotoColumns() {
  const columns = await all('PRAGMA table_info(submissions)');
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('photo_before')) {
    await run('ALTER TABLE submissions ADD COLUMN photo_before TEXT');
  }
  if (!columnNames.has('photo_after')) {
    await run('ALTER TABLE submissions ADD COLUMN photo_after TEXT');
  }

  await run(`UPDATE submissions
    SET photo_after = COALESCE(photo_after, image_name)
    WHERE image_name IS NOT NULL AND (photo_after IS NULL OR photo_after = '')`);
}

async function ensureAccumulatingTicketsTable() {
  const existing = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'");
  const desiredSql = `CREATE TABLE tickets (
    ticket_number INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    type TEXT DEFAULT 'standard' CHECK(type IN ('standard', 'bonus')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'winner', 'scratched')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  )`;

  if (!existing) {
    await run(desiredSql);
    return;
  }

  const sql = String(existing.sql || '').toLowerCase();
  const hasProperPrimaryKey = sql.includes('ticket_number integer primary key autoincrement');
  const hasTgIdUniqueness = sql.includes('unique') && sql.includes('tg_id');
  const columns = await all('PRAGMA table_info(tickets)');
  const hasStatus = columns.some((column) => column.name === 'status');

  if (hasProperPrimaryKey && !hasTgIdUniqueness && sql.includes("'scratched'")) {
    if (!hasStatus) await run("ALTER TABLE tickets ADD COLUMN status TEXT DEFAULT 'active' CHECK(status IN ('active', 'winner', 'scratched'))");
    await run("UPDATE tickets SET status = 'active' WHERE status IS NULL OR status = ''");
    return;
  }

  await run('ALTER TABLE tickets RENAME TO tickets_old');
  await run(desiredSql);
  const statusExpression = hasStatus
    ? "CASE WHEN status IN ('active', 'winner', 'scratched') THEN status WHEN status = 'burnt' THEN 'scratched' ELSE 'active' END"
    : "'active'";
  await run(`INSERT INTO tickets (ticket_number, tg_id, type, status, created_at)
    SELECT ticket_number, tg_id, COALESCE(type, 'standard'),
      ${statusExpression},
      COALESCE(created_at, CURRENT_TIMESTAMP)
    FROM tickets_old
    WHERE tg_id IS NOT NULL
    ORDER BY ticket_number ASC`);
  await run('DROP TABLE tickets_old');
}


async function ensureRaffleConfigTable() {
  await run(`CREATE TABLE IF NOT EXISTS raffle_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    raffle_start TEXT DEFAULT '',
    raffle_end TEXT DEFAULT '',
    total_prizes INTEGER DEFAULT 0,
    remaining_prizes INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`INSERT INTO raffle_config (id, raffle_start, raffle_end, total_prizes, remaining_prizes)
    VALUES (1, '', '', 0, 0)
    ON CONFLICT(id) DO NOTHING`);
}

async function ensureRaffleResultsTable() {
  await run(`CREATE TABLE IF NOT EXISTS raffle_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_number INTEGER NOT NULL UNIQUE,
    ticket_number INTEGER NOT NULL UNIQUE,
    tg_id TEXT NOT NULL,
    username TEXT DEFAULT '',
    drawn_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_number) REFERENCES tickets(ticket_number),
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  )`);
}


async function ensureNewsEventsTable() {
  await run(`CREATE TABLE IF NOT EXISTS news_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    event_type TEXT DEFAULT 'system',
    tg_id TEXT DEFAULT '',
    ticket_number INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  )`);
}

async function seedTasks() {
  const rawTasks = `1. Раскрась кадр из мультфильма, используя только оттенки серого (эффект старого кино)
2. Её волосы светятся, когда она поет
3. Раскрась Малефисенту в радужных, добрых тонах
4. 🧊 + ❄️ + 👑 
Твоя задача - персонаж из мультфильма
5. Маленькая деревянная кукла с растущим носом
6. 🍳 + 🦎 + 👑 
Твоя задача - персонаж из мультфильма
7. 🎸 + 💀
Твоя задача - персонаж из мультфильма
8. Нарисуй любого персонажа Disney в стиле аниме
9. Очень важно пробовать новое! Время нарисовать фломастерную работу. У тебя получится!
10. 🕰 + 🕯 + ☕️ + 🏰
Твоя задача - сцена из мульфильма с присутствием загаданных персонажей
11. Раскрась персонажа, используя только «комплементарную триаду» цветового круга (например, фиолетовый, оранжевый и зеленый).
12. 🧪 + 🎩 + 🐰 + ☕️
Твоя задача - сцена из мульфильма с присутствием загаданных персонажей
13. Я нахожусь напротив синего на цветовом круге и превращаю его в серый при смешивании. Кто я? (Ответ - кодовое слово и задача на этап)
14. Я — техника, где два цвета плавно перетекают друг в друга, как небо на закате. (Ответ - кодовое слово и задача на этап)
15. Я — цвет, который получается, если смешать страсть красного и спокойствие синего.  (Ответ - кодовое слово и задача на этап)
16. Если ты хочешь, чтобы твой персонаж «выпрыгнул» из кадра, используй меня на фоне. Я нахожусь на противоположной стороне круга.  (Ответ - кодовое слово и задача на этап)
17. Цвета этой температуры напоминают лед, воду и ночное небо. (Ответ - кодовое слово и задача на этап)
18. Как называется чистота и яркость цвета, когда в нем нет ни капли серого? (Ответ - кодовое слово и задача на этап)
19. Он — единственный герой, который не сказал ни слова за весь свой сольный мультфильм.  (Ответ - кодовое слово и задача на этап)
20. Единственная принцесса, у которой есть татуировка (ого!). (Ответ - кодовое слово и задача на этап)
21. Его имя в переводе с суахили означает просто «Лев». (Ответ - кодовое слово и задача на этап)
22. Предмет интерьера в замке Чудовища, который постоянно ворчал и следил за порядком? (Ответ - кодовое слово и задача - любой персонаж из мультфильма)
23. Единственная принцесса, основанная на реальном историческом лице. (Ответ - кодовое слово и задача на этап)
24. Чтобы я стала послушной и яркой, мне нужна всего одна капля воды. (Ответ - кодовое слово и обязательный материал на этап)
25. «Код 50/50»: Заполни ровно половину номеров на картинке и пришли скриншот — это будет «незаконченный шедевр». (Наименование задания - кодовое слово, рисуй, что нравится)
26. «Пиксельный минимализм»: Используй в работе только 5 цветов, даже если по схеме их 20. (Наименование задания - кодовое слово, рисуй, что нравится)
27. «Слепая зона»: Выбери один номер на схеме и раскрась его «неродным» цветом (например, вместо синего — золотым). (Наименование задания - кодовое слово, рисуй, что нравится)
28. «Пиксельный Микки»: Нарисуй голову Микки Мауса по клеточкам в углу своей основной работы. (Наименование задания - кодовое слово, рисуй, что нравится)
29. «Цвета принцесс»: Используй палитру Ариэль (зеленый, красный, фиолетовый) для раскрашивания любого животного. (Наименование задания - кодовое слово, рисуй, что нравится)
[02.06.2026 18:44] Рисовальня: 30. «Волшебная пыльца»: Добавь «блеска» (точечками) поверх уже раскрашенных номеров в конце работы. (Наименование задания - кодовое слово, рисуй, что нравится)
31. «Disney-животное»: Раскрась обычного кота из раскраски так, чтобы он стал похож на Чеширского кота. (Наименование задания - кодовое слово)
32. «Радужный зверь»: Если на картинке животное с однотонной шерстью, добавь в неё пару прядей неожиданного цвета (например, розовый в гриву льва). (Наименование задания - кодовое слово)
33. «Альбинос»: Раскрась всё вокруг животного, а самого зверя оставь белым, проработав только тени серым цветом. (Наименование задания - кодовое слово)
34. «Золотая чешуя»: Найди на картинке рыбу или рептилию и сделай один элемент «золотым» (например, желтый + оранжевые тени). (Наименование задания - кодовое слово)
35. «Следы лап»: На твоем изображении должны быть запрятаны 4 маленьких отпечатки лапок (Наименование задания - кодовое слово, рисуй, что нравится)
36. «Магия искр»: Добавь россыпь мелких белых точек вокруг героя — как будто Фея Динь-Динь пролетела рядом. (Наименование задания - кодовое слово, рисуй, что нравится)
37. 🐭 + 🔴 + 🎀
Твоя задача - персонаж из мультфильма
38. «Творческая подпись»: Придумай себе «автограф художника» и поставь его внизу работы. (Наименование задания - кодовое слово, рисуй, что нравится)
39. «Цветовой шпион»: Найди в комнате предмет такого же цвета, как оттенок №3 в палитре, и сфотографируй их вместе с готовой работой. (Наименование задания - кодовое слово, рисуй, что нравится)
40. «Великий финал»: Когда закончишь всю страницу, обведи самый любимый фрагмент золотым или блестящим контуром.  (Наименование задания - кодовое слово, рисуй, что нравится)
41. «Страница-загадка»: Открой страницу, номер которой совпадает с твоим возрастом. (Наименование задания - кодовое слово, не забудь подписать нужную цифру)
42. «Микро-мир»: Найди страницу с насекомым. Раскрась его крылья самым ярким цветом.  (Наименование задания - кодовое слово)
43. «Зоопарк на выезде»: Найди страницу, где изображено больше трех разных животных одновременно.(Наименование задания - кодовое слово)
44. «Потерянная туфелька»: Найди страницу с четным номером, где у персонажа видна обувь. Раскрась её в золотой. (Наименование задания - кодовое слово)
45. «Подводная одиссея»: Найди страницу с пузырьками или водой. Раскрась их блестящей ручкой. (Наименование задания - кодовое слово)
46. «Цветовой детектив»: Найди страницу, где в легенде (номерах цветов) меньше семи оттенков. (Наименование задания - кодовое слово)
47. «Фоновый мастер»: Найди страницу с самым большим пустым фоном. Заполни <50% этого фона узором «в горошек». (Наименование задания - кодовое слово)
[20.03.2026 12:44] Рисовальня: 48. «Тайное послание»: Напиши на странице №10 первую букву своего имени и обведи её в сердечко. (Наименование задания - кодовое слово, рисуй, что нравится)
49. Она не носит платья, но носит имя, которое означает «Деревянная магнолия». В начале пути она ищет своё лицо в зеркале предков, а в конце — находит его на лезвии меча. О ком речь? (Ответ - кодовое слово и задача на этап)
50. Он не был призван гонгом и не является истинным хранителем, хотя занимает это место. Его задача — пробудить Великого Каменного Дракона, но вместо этого он сам становится «огненным дыханием» в кармане. (Ответ - кодовое слово и задача на этап)
51. У него нет голоса, но есть «золотая» репутация. Бабушка Фа верила, что он принесет удачу, переходя дорогу с закрытыми глазами. (Ответ - кодовое слово. задача на этап - любой не человек из этого мультфильма)
52. Этот предмет был оставлен на ночном столике как знак обмена. Он символизирует женственность, которую героиня «срезала» вместе с волосами, и долг, который она взяла на себя вместо отца.  (Ответ - кодовое слово. задача на этап - любой человек из этого мультфильма)
53. Один мечтает о девушке, которая умеет готовить, второй — о той, что оценит его силу, а третий просто хочет вернуться к своей маме. Вместе они переоделись в наложниц, чтобы спасти императора. Назови имена этой троицы.(Ответ - кодовое слово. задача на этап - любой загаданный человек из этого мультфильма)
54. У меня есть «феноменальная космическая мощь», но моё жилье не превышает размеров чайной чашки. Я видел смену эпох, но не видел свободы, пока мой хозяин не произнес три заветных слова. (Ответ - кодовое слово и задача на этап)
55. Джафар хотел стать самым могущественным существом во Вселенной. Он получил силу, которую просил, но забыл про «мелкий шрифт» в контракте. Кем он стал в итоге? (Ответ - кодовое слово и задача на этап)
56. Её лицо кажется принцу Эрику знакомым, а голос — тем самым, что спас его на берегу. Но на самом деле это лишь маскировка ведьмы, использующая магию и украденную ракушку. Под каким именем она вышла на берег? (Ответ - кодовое слово и задача на этап)
57. «Ассоциативная цепочка»: Загадано слово "холод". Рисовать снежки, лед и снег запрещено ;) (Наименование задания - кодовое слово, рисуй, что нравится)`;

  const tasks = rawTasks
    .split('\n')
    .map((task) => task.trim())
    .filter((task) => task.length > 0);

  await run('DELETE FROM tasks;');

  for (const task of tasks) {
    await run('INSERT OR IGNORE INTO tasks (text_task) VALUES (?)', [task]);
  }
}

function normalizeTgId(value) {
  const tgId = String(value || '').trim();
  if (!tgId) throw Object.assign(new Error('Не передан Telegram ID'), { status: 400 });
  return tgId;
}

function normalizeUsername(value, fallback = '') {
  return String(value || fallback || '').trim().slice(0, 80);
}

async function findOrRefreshKnownUser(tgId, username = '') {
  const user = await get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
  if (!user) return null;

  const role = ADMIN_TG_IDS.has(String(tgId)) ? 'admin' : user.role;
  const updates = [];
  const params = [];
  if (username) {
    updates.push('username = ?');
    params.push(username);
  }
  if (role === 'admin' && user.role !== 'admin') {
    updates.push("role = 'admin'", 'is_approved = 1');
  }
  if (updates.length) {
    params.push(tgId);
    await run(`UPDATE users SET ${updates.join(', ')} WHERE tg_id = ?`, params);
  }
  return get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
}

async function createOrRefreshApplication(tgId, username = '') {
  const role = ADMIN_TG_IDS.has(String(tgId)) ? 'admin' : 'user';
  const approved = role === 'admin' ? 1 : 0;
  await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role)
    VALUES (?, ?, 0, ?, 0, ?)
    ON CONFLICT(tg_id) DO UPDATE SET
      username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE users.username END,
      role = CASE WHEN users.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE users.role END,
      is_approved = CASE WHEN users.role = 'admin' OR excluded.role = 'admin' THEN 1 ELSE users.is_approved END`,
    [tgId, username, approved, role]);
  return get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
}

async function requireApproved(tgId) {
  const user = await get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
  if (!user) throw Object.assign(new Error('Игрок не найден. Подайте заявку на участие.'), { status: 404 });
  if (Number(user.is_approved) !== 1) throw Object.assign(new Error('Игрок еще не одобрен администратором'), { status: 403 });
  return user;
}

async function requireAdmin(tgId) {
  const normalized = normalizeTgId(tgId);
  if (!ADMIN_TG_IDS.has(normalized)) {
    throw Object.assign(new Error('Доступ только для администратора'), { status: 403 });
  }
  await createOrRefreshApplication(normalized, 'Owner');
  return requireApproved(normalized);
}


function formatUserHandle(username, tgId = '') {
  const cleanUsername = String(username || '').trim().replace(/^@+/, '');
  return cleanUsername ? `@${cleanUsername}` : `ID ${tgId || '—'}`;
}

async function addNewsEvent(message, { eventType = 'system', tgId = '', ticketNumber = null } = {}) {
  const normalizedMessage = String(message || '').trim();
  if (!normalizedMessage) return null;
  const result = await run(
    'INSERT INTO news_events (message, event_type, tg_id, ticket_number) VALUES (?, ?, ?, ?)',
    [normalizedMessage, eventType, String(tgId || ''), ticketNumber]
  );
  return get('SELECT id, message, event_type, tg_id, ticket_number, created_at FROM news_events WHERE id = ?', [result.id]);
}

async function getNewsEvents(limit = 30) {
  const safeLimit = Math.max(1, Math.min(80, Number(limit) || 30));
  return all(`SELECT id, message, event_type, tg_id, ticket_number, created_at
    FROM news_events
    ORDER BY id DESC
    LIMIT ?`, [safeLimit]);
}

async function addApprovalNewsEvents(user, issuedTickets = []) {
  const handle = formatUserHandle(user?.username, user?.tg_id);
  const standardTicket = issuedTickets.find((ticket) => ticket.type === 'standard') || issuedTickets[0];
  if (standardTicket) {
    await addNewsEvent(`🎨 Красочка №${standardTicket.ticket_number} досталась ${handle}!`, {
      eventType: 'ticket_issued',
      tgId: user.tg_id,
      ticketNumber: standardTicket.ticket_number
    });
  }

  const currentCell = Number(user?.current_cell || 0);
  const milestones = [
    [50, `🎉 ${handle} на 50-й клеточке! Поздравляем с экватором!`],
    [70, `🔥 ${handle} дошел до 70-й клетки! Финиш близко!`],
    [100, `🏆 УРА! ${handle} дошел до ФИНАЛА (100 клетка) и получает 2 бонусные Красочки!`]
  ];

  for (const [cell, message] of milestones) {
    if (currentCell < cell) continue;
    const eventType = `cell_${cell}`;
    const existing = await get('SELECT id FROM news_events WHERE tg_id = ? AND event_type = ? LIMIT 1', [user.tg_id, eventType]);
    if (existing) continue;
    await addNewsEvent(message, {
      eventType,
      tgId: user.tg_id,
      ticketNumber: standardTicket?.ticket_number || null
    });
  }
}

async function getActiveSubmission(tgId) {
  return get(`SELECT s.*, t.text_task
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.tg_id = ? AND s.status IN ('pending', 'rejected')
    ORDER BY s.id DESC
    LIMIT 1`, [tgId]);
}

async function getPlayerTickets(tgId) {
  return all('SELECT ticket_number, type, status, created_at FROM tickets WHERE tg_id = ? ORDER BY ticket_number ASC', [tgId]);
}

const TRAP_CELLS = new Set([13, 26, 39, 52, 65, 78, 91]);
const LUCKY_CELLS = new Set([7, 21, 35, 49, 63, 77, 88]);
const LUCKY_TASK_OPTIONS = [
  'Раскрасить что угодно вне заданий',
  'Взять картинку формата менее А4'
];

function getCellType(cell) {
  const normalized = Number(cell || 0);
  if (TRAP_CELLS.has(normalized)) return 'trap';
  if (LUCKY_CELLS.has(normalized)) return 'lucky';
  return 'ordinary';
}

async function pickUnusedTask(tgId) {
  const task = await get(`SELECT id, text_task
    FROM tasks
    WHERE id NOT IN (
      SELECT task_id FROM submissions WHERE tg_id = ? AND status IN ('approved', 'pending')
    )
    ORDER BY RANDOM()
    LIMIT 1`, [tgId]);

  if (task) return task;
  return get('SELECT id, text_task FROM tasks ORDER BY RANDOM() LIMIT 1');
}

async function issueTicket(tgId, type = 'standard') {
  const result = await run("INSERT INTO tickets (tg_id, type, status) VALUES (?, ?, 'active')", [tgId, type]);
  return get('SELECT ticket_number, type, status FROM tickets WHERE ticket_number = ?', [result.id]);
}

function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

function shuffleTickets(tickets) {
  return [...tickets]
    .map((ticket) => ({ ticket, sort: crypto.randomInt(0, 1_000_000_000) }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ ticket }) => ticket);
}

function buildUniqueWinnerDraw(tickets) {
  const usedPlayers = new Set();
  const burnedTickets = [];
  const winners = [];

  for (const ticket of shuffleTickets(tickets)) {
    if (usedPlayers.has(ticket.tg_id)) {
      burnedTickets.push(ticket);
      continue;
    }
    usedPlayers.add(ticket.tg_id);
    winners.push(ticket);
  }

  return { winners, burnedTickets };
}

async function getRaffleConfig() {
  return get(`SELECT id, raffle_start, raffle_end, total_prizes, remaining_prizes, updated_at
    FROM raffle_config WHERE id = 1`);
}

function normalizeRaffleDate(value, label) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    throw Object.assign(new Error(`Некорректная дата/время: ${label}`), { status: 400 });
  }
  return new Date(timestamp).toISOString();
}

function buildRaffleWindow(config) {
  const startMs = config?.raffle_start ? Date.parse(config.raffle_start) : NaN;
  const endMs = config?.raffle_end ? Date.parse(config.raffle_end) : NaN;
  const nowMs = Date.now();
  const configured = Number.isFinite(startMs) && Number.isFinite(endMs) && Number(config?.total_prizes || 0) > 0;
  return {
    server_now: new Date(nowMs).toISOString(),
    is_configured: configured,
    is_before_start: configured && nowMs <= startMs,
    is_active: configured && nowMs > startMs && nowMs < endMs,
    is_finished: configured && nowMs >= endMs
  };
}

async function getRaffleStatus() {
  const [config, results, latestWinner, stats] = await Promise.all([
    getRaffleConfig(),
    all(`SELECT id, place_number, ticket_number, tg_id, username, drawn_at
      FROM raffle_results
      ORDER BY place_number ASC`),
    get(`SELECT id, place_number, ticket_number, tg_id, username, drawn_at
      FROM raffle_results
      ORDER BY place_number DESC
      LIMIT 1`),
    get(`SELECT
        COUNT(*) AS total_tickets,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_tickets,
        SUM(CASE WHEN status = 'winner' THEN 1 ELSE 0 END) AS winner_tickets,
        SUM(CASE WHEN status = 'scratched' THEN 1 ELSE 0 END) AS scratched_tickets
      FROM tickets`)
  ]);

  return {
    config,
    ...buildRaffleWindow(config),
    results,
    latest_winner: latestWinner || null,
    total_tickets: stats?.total_tickets || 0,
    active_tickets: stats?.active_tickets || 0,
    winner_tickets: stats?.winner_tickets || 0,
    scratched_tickets: stats?.scratched_tickets || 0,
    remaining_prizes: Number(config?.remaining_prizes || 0)
  };
}

async function scratchTicket({ tgId, ticketNumber }) {
  const user = await requireApproved(tgId);
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const config = await getRaffleConfig();
    const windowState = buildRaffleWindow(config);
    if (!windowState.is_active) {
      throw Object.assign(new Error('Красочки сейчас недоступны: проверьте время старта и финиша'), { status: 403 });
    }

    const ticket = await get(`SELECT ticket_number, tg_id, type, status
      FROM tickets
      WHERE ticket_number = ? AND tg_id = ?`, [ticketNumber, tgId]);
    if (!ticket) throw Object.assign(new Error('Красочка не найдена у текущего игрока'), { status: 404 });
    if (ticket.status !== 'active') throw Object.assign(new Error('Эта Красочка уже стерта'), { status: 400 });

    const counters = await get(`SELECT
        COUNT(*) AS active_tickets,
        (SELECT remaining_prizes FROM raffle_config WHERE id = 1) AS remaining_prizes
      FROM tickets
      WHERE status = 'active'`);
    const activeTickets = Number(counters?.active_tickets || 0);
    const remainingPrizes = Number(counters?.remaining_prizes || 0);
    if (activeTickets <= 0) throw Object.assign(new Error('Активных Красочек не осталось'), { status: 400 });

    const wins = remainingPrizes > 0 && (remainingPrizes >= activeTickets || crypto.randomInt(activeTickets) < remainingPrizes);

    if (wins) {
      const place = await get('SELECT COALESCE(MAX(place_number), 0) + 1 AS place_number FROM raffle_results');
      const placeNumber = Number(place?.place_number || 1);
      await run("UPDATE tickets SET status = 'winner' WHERE ticket_number = ? AND status = 'active'", [ticketNumber]);
      await run(`UPDATE raffle_config
        SET remaining_prizes = MAX(remaining_prizes - 1, 0), updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`, []);
      const inserted = await run(`INSERT INTO raffle_results (place_number, ticket_number, tg_id, username)
        VALUES (?, ?, ?, ?)`, [placeNumber, ticketNumber, tgId, user.username || '']);
      await run('COMMIT');

      await addNewsEvent(`🎉 Юзер ${formatUserHandle(user.username, user.tg_id)} нашел МОНЕТКУ и выиграл приз!`, {
        eventType: 'scratch_win',
        tgId: user.tg_id,
        ticketNumber
      });

      return {
        result: 'win',
        winner: {
          id: inserted.id,
          place_number: placeNumber,
          ticket_number: ticketNumber,
          tg_id: tgId,
          username: user.username || '',
          drawn_at: new Date().toISOString()
        }
      };
    }

    await run("UPDATE tickets SET status = 'scratched' WHERE ticket_number = ? AND status = 'active'", [ticketNumber]);
    await run('COMMIT');
    return { result: 'lose' };
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
}

app.get('/api/me/:tgId', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.params.tgId);
    const username = normalizeUsername(req.query.username, `user_${tgId}`);
    const user = await findOrRefreshKnownUser(tgId, username);

    if (!user) {
      res.json({ user: null, activeSubmission: null, tickets: [], needs_application: true, is_finalist: false, is_admin: ADMIN_TG_IDS.has(tgId) });
      return;
    }

    const activeSubmission = Number(user.is_approved) === 1 ? await getActiveSubmission(tgId) : null;
    const tickets = Number(user.is_approved) === 1 ? await getPlayerTickets(tgId) : [];
    const pendingLucky = Number(user.is_approved) === 1 && user.pending_lucky_cell !== null
      ? { cell: Number(user.pending_lucky_cell), options: LUCKY_TASK_OPTIONS }
      : null;
    res.json({ user, activeSubmission, pendingLucky, tickets, needs_application: false, is_finalist: Number(user.current_cell) >= 100, is_admin: user.role === 'admin' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/apply', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const username = normalizeUsername(req.body.username, `user_${tgId}`);
    const user = await createOrRefreshApplication(tgId, username);
    res.json({ ok: true, user, is_admin: user.role === 'admin' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/raffle', async (_req, res, next) => {
  try {
    const [raffle, finalists] = await Promise.all([
      getRaffleStatus(),
      all(`SELECT u.tg_id, u.username, u.current_cell, COUNT(t.ticket_number) AS tickets_count
        FROM users u
        LEFT JOIN tickets t ON t.tg_id = u.tg_id
        WHERE u.is_approved = 1 AND u.current_cell >= 100
        GROUP BY u.tg_id
        ORDER BY u.current_cell DESC, u.username COLLATE NOCASE ASC, u.tg_id ASC`)
    ]);
    res.json({ ...raffle, finalists });
  } catch (error) {
    next(error);
  }
});

app.get('/api/raffle/status', async (_req, res, next) => {
  try {
    res.json(await getRaffleStatus());
  } catch (error) {
    next(error);
  }
});

app.post('/api/raffle/scratch-ticket', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const ticketNumber = Number(req.body.ticket_number);
    if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
      throw Object.assign(new Error('Некорректный номер Красочки'), { status: 400 });
    }
    res.json({ ok: true, ...(await scratchTicket({ tgId, ticketNumber })), ...(await getRaffleStatus()) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/raffle-config', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    res.json(await getRaffleStatus());
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/raffle-config', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const raffleStart = normalizeRaffleDate(req.body.raffle_start, 'raffle_start');
    const raffleEnd = normalizeRaffleDate(req.body.raffle_end, 'raffle_end');
    const totalPrizes = Number(req.body.total_prizes);
    if (!Number.isInteger(totalPrizes) || totalPrizes < 0) {
      throw Object.assign(new Error('Количество призов должно быть целым числом от 0'), { status: 400 });
    }
    if (raffleStart && raffleEnd && Date.parse(raffleStart) >= Date.parse(raffleEnd)) {
      throw Object.assign(new Error('Дата старта должна быть раньше даты окончания'), { status: 400 });
    }

    const current = await getRaffleConfig();
    const usedPrizes = await get('SELECT COUNT(*) AS count FROM raffle_results');
    const previouslyUsed = Number(usedPrizes?.count || 0);
    const datesChanged = raffleStart !== current.raffle_start || raffleEnd !== current.raffle_end;
    const totalChanged = totalPrizes !== Number(current.total_prizes || 0);
    const remaining = datesChanged || totalChanged
      ? Math.max(0, totalPrizes - previouslyUsed)
      : Math.min(Number(current.remaining_prizes || 0), totalPrizes);

    await run(`UPDATE raffle_config
      SET raffle_start = ?, raffle_end = ?, total_prizes = ?, remaining_prizes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`, [raffleStart, raffleEnd, totalPrizes, remaining]);

    res.json({ ok: true, ...(await getRaffleStatus()) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/news', async (req, res, next) => {
  try {
    const events = await getNewsEvents(req.query.limit);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

async function createPendingSubmissionForCell(tgId, cell) {
  const task = await pickUnusedTask(tgId);
  if (!task) throw Object.assign(new Error('В базе нет заданий'), { status: 500 });
  const submission = await run('INSERT INTO submissions (tg_id, cell, task_id, status) VALUES (?, ?, ?, ?)', [tgId, cell, task.id, 'pending']);
  return { task, submission_id: submission.id };
}

app.post('/api/roll', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    if (Number(user.dice_frozen) === 1) throw Object.assign(new Error('Кубик заморожен до проверки задания'), { status: 400 });
    if (Number(user.current_cell) >= 100) throw Object.assign(new Error('Вы уже дошли до финиша'), { status: 400 });

    const dice = rollD6();
    const landedCell = Math.min(100, Number(user.current_cell || 0) + dice);
    const cellType = getCellType(landedCell);

    if (cellType === 'lucky') {
      await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = ? WHERE tg_id = ?', [landedCell, landedCell, tgId]);
      res.json({ ok: true, dice, current_cell: landedCell, cell_type: cellType, lucky_options: LUCKY_TASK_OPTIONS });
      return;
    }

    let currentCell = landedCell;
    let trapDice = null;
    if (cellType === 'trap') {
      trapDice = rollD6();
      currentCell = Math.max(0, landedCell - trapDice);
    }

    const pending = await createPendingSubmissionForCell(tgId, currentCell);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL WHERE tg_id = ?', [currentCell, tgId]);

    res.json({ ok: true, dice, trap_dice: trapDice, landed_cell: landedCell, current_cell: currentCell, cell_type: cellType, ...pending });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reroll-task', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    const active = await getActiveSubmission(tgId);
    if (!active || active.status !== 'pending' || active.photo_before || active.photo_after) {
      throw Object.assign(new Error('Сменить можно только новое задание до загрузки фото'), { status: 400 });
    }
    if (getCellType(active.cell) !== 'ordinary') throw Object.assign(new Error('На этой клетке смена задания недоступна'), { status: 400 });

    const penalty = Math.floor(Math.random() * 3) + 1;
    const currentCell = Math.max(0, Number(user.current_cell || 0) - penalty);
    await run('DELETE FROM submissions WHERE id = ?', [active.id]);
    const pending = await createPendingSubmissionForCell(tgId, currentCell);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL WHERE tg_id = ?', [currentCell, tgId]);

    res.json({ ok: true, penalty, current_cell: currentCell, ...pending });
  } catch (error) {
    next(error);
  }
});

app.post('/api/lucky-choice', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    const choice = String(req.body.choice || '').trim();
    if (!LUCKY_TASK_OPTIONS.includes(choice)) throw Object.assign(new Error('Выберите один из бонусных вариантов'), { status: 400 });
    const luckyCell = Number(user.pending_lucky_cell);
    if (!Number.isInteger(luckyCell) || getCellType(luckyCell) !== 'lucky') throw Object.assign(new Error('Бонусная клетка не ожидает выбора'), { status: 400 });

    const result = await run('INSERT OR IGNORE INTO tasks (text_task) VALUES (?)', [choice]);
    const task = result.id ? await get('SELECT id, text_task FROM tasks WHERE id = ?', [result.id]) : await get('SELECT id, text_task FROM tasks WHERE text_task = ?', [choice]);
    const submission = await run('INSERT INTO submissions (tg_id, cell, task_id, status) VALUES (?, ?, ?, ?)', [tgId, luckyCell, task.id, 'pending']);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL WHERE tg_id = ?', [luckyCell, tgId]);

    res.json({ ok: true, current_cell: luckyCell, task, submission_id: submission.id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/submit', upload.fields([
  { name: 'photo_before', maxCount: 1 },
  { name: 'photo_after', maxCount: 1 },
  { name: 'work_image', maxCount: 1 }
]), async (req, res, next) => {
  const uploadedFiles = Object.values(req.files || {}).flat();
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    await requireApproved(tgId);

    const photoBefore = req.files?.photo_before?.[0];
    const photoAfter = req.files?.photo_after?.[0] || req.files?.work_image?.[0];
    if ((photoBefore && photoAfter) || (!photoBefore && !photoAfter)) {
      throw Object.assign(new Error('Загрузите ровно одно фото: ДО или ПОСЛЕ'), { status: 400 });
    }

    const active = await getActiveSubmission(tgId);
    if (!active) throw Object.assign(new Error('Сначала бросьте кубик и получите задание'), { status: 400 });
    if (active.status === 'pending' && active.photo_before && active.photo_after) {
      throw Object.assign(new Error('Пара фото уже ожидает проверки'), { status: 400 });
    }

    let uploadedStage = 'before';
    let filename = photoBefore?.filename;

    if (photoBefore) {
      await run(`UPDATE submissions
        SET photo_before = ?, photo_after = NULL, image_name = NULL, status = 'pending', admin_comment = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`, [photoBefore.filename, active.id]);
    } else {
      if (!active.photo_before) {
        throw Object.assign(new Error('Сначала загрузите фото ДО'), { status: 400 });
      }
      uploadedStage = 'after';
      filename = photoAfter.filename;
      await run(`UPDATE submissions
        SET photo_after = ?, image_name = ?, status = 'pending', admin_comment = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`, [photoAfter.filename, photoAfter.filename, active.id]);
    }

    const submission = await getActiveSubmission(tgId);
    res.json({ ok: true, uploaded_stage: uploadedStage, image_name: filename, submission });
  } catch (error) {
    for (const file of uploadedFiles) {
      await fs.promises.rm(path.join(UPLOADS_DIR, file.filename), { force: true }).catch(() => {});
    }
    next(error);
  }
});

app.get('/api/check-status/:tgId', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.params.tgId);
    const user = await requireApproved(tgId);
    const submission = await get(`SELECT s.*, t.text_task
      FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.tg_id = ?
      ORDER BY s.id DESC
      LIMIT 1`, [tgId]);
    const tickets = await getPlayerTickets(tgId);
    res.json({ submission, dice_frozen: user.dice_frozen, tickets, is_finalist: Number(user.current_cell) >= 100 });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/pending-users', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const users = await all(`SELECT tg_id, username, current_cell, is_approved, dice_frozen, role
      FROM users
      WHERE is_approved = 0
      ORDER BY username COLLATE NOCASE ASC, tg_id ASC`);
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/approve-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    const result = await run('UPDATE users SET is_approved = 1, current_cell = 0, dice_frozen = 0, pending_lucky_cell = NULL WHERE tg_id = ?', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Заявка не найдена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reject-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    if (tgId === OWNER_TG_ID) throw Object.assign(new Error('Нельзя отклонить супер-админа'), { status: 400 });
    await run('DELETE FROM submissions WHERE tg_id = ?', [tgId]);
    await run('DELETE FROM tickets WHERE tg_id = ?', [tgId]);
    const result = await run('DELETE FROM users WHERE tg_id = ? AND is_approved = 0', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Заявка не найдена или уже одобрена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const users = await all(`SELECT u.tg_id, u.username, u.current_cell, u.is_approved, u.dice_frozen, u.role,
        COUNT(t.ticket_number) AS tickets_count
      FROM users u
      LEFT JOIN tickets t ON t.tg_id = u.tg_id
      GROUP BY u.tg_id
      ORDER BY u.role DESC, u.is_approved DESC, u.username COLLATE NOCASE ASC, u.tg_id ASC`);
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/remove-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    if (tgId === OWNER_TG_ID) throw Object.assign(new Error('Нельзя исключить супер-админа'), { status: 400 });
    const result = await run('UPDATE users SET is_approved = 0, dice_frozen = 0, pending_lucky_cell = NULL WHERE tg_id = ?', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Игрок не найден'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/change-cell', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    const currentCell = Number(req.body.current_cell);
    if (!Number.isInteger(currentCell) || currentCell < 0 || currentCell > 100) {
      throw Object.assign(new Error('Клетка должна быть целым числом от 0 до 100'), { status: 400 });
    }
    const result = await run('UPDATE users SET current_cell = ?, pending_lucky_cell = NULL WHERE tg_id = ?', [currentCell, tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Игрок не найден'), { status: 404 });
    res.json({ ok: true, current_cell: currentCell });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reset-dice', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    const result = await run('UPDATE users SET dice_frozen = 0, pending_lucky_cell = NULL WHERE tg_id = ?', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Игрок не найден'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const submissions = await all(`SELECT s.id, s.tg_id, s.cell, s.task_id, s.image_name, s.photo_before, s.photo_after, s.status, s.admin_comment,
        u.username, t.text_task
      FROM submissions s
      JOIN users u ON u.tg_id = s.tg_id
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending' AND s.photo_before IS NOT NULL AND s.photo_after IS NOT NULL
      ORDER BY s.updated_at ASC, s.id ASC`);
    res.json({ submissions });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/tasks', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const tasks = await all(`SELECT id, text_task
      FROM tasks
      ORDER BY id DESC`);
    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/tasks', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const textTask = String(req.body.text_task || '').trim();
    if (!textTask) throw Object.assign(new Error('Введите текст задания'), { status: 400 });
    const result = await run('INSERT INTO tasks (text_task) VALUES (?)', [textTask]);
    const task = await get('SELECT id, text_task FROM tasks WHERE id = ?', [result.id]);
    res.status(201).json({ ok: true, task });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/remove-task', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const taskId = Number(req.body.task_id);
    if (!Number.isInteger(taskId) || taskId < 1) throw Object.assign(new Error('Некорректный ID задания'), { status: 400 });
    const usage = await get('SELECT COUNT(*) AS count FROM submissions WHERE task_id = ?', [taskId]);
    if (Number(usage?.count || 0) > 0) {
      throw Object.assign(new Error('Нельзя удалить задание, которое уже назначено игрокам'), { status: 400 });
    }
    const result = await run('DELETE FROM tasks WHERE id = ?', [taskId]);
    if (result.changes === 0) throw Object.assign(new Error('Задание не найдено'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/approve-submission', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const submissionId = Number(req.body.submission_id);
    if (!Number.isInteger(submissionId)) throw Object.assign(new Error('Некорректный ID работы'), { status: 400 });

    const submission = await get(`SELECT s.id, s.tg_id, s.cell, u.current_cell, u.username
      FROM submissions s
      JOIN users u ON u.tg_id = s.tg_id
      WHERE s.id = ? AND s.status = 'pending' AND s.photo_before IS NOT NULL AND s.photo_after IS NOT NULL`, [submissionId]);
    if (!submission) throw Object.assign(new Error('Работа не найдена или уже проверена'), { status: 404 });

    await run("UPDATE submissions SET status = 'approved', admin_comment = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [submissionId]);
    await run('UPDATE users SET dice_frozen = 0, pending_lucky_cell = NULL WHERE tg_id = ?', [submission.tg_id]);

    const issuedTickets = [await issueTicket(submission.tg_id, 'standard')];
    const userAfterApproval = await get('SELECT tg_id, username, current_cell FROM users WHERE tg_id = ?', [submission.tg_id]);
    if (Number(userAfterApproval.current_cell) >= 100) {
      issuedTickets.push(await issueTicket(submission.tg_id, 'bonus'));
      issuedTickets.push(await issueTicket(submission.tg_id, 'bonus'));
    }
    await addApprovalNewsEvents(userAfterApproval, issuedTickets);

    res.json({ ok: true, issuedTickets, is_finalist: Number(userAfterApproval.current_cell) >= 100 });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reject-submission', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const submissionId = Number(req.body.submission_id);
    const comment = String(req.body.admin_comment || '').trim();
    if (!Number.isInteger(submissionId)) throw Object.assign(new Error('Некорректный ID работы'), { status: 400 });
    if (!comment) throw Object.assign(new Error('Добавьте комментарий для отклонения'), { status: 400 });

    const result = await run(`UPDATE submissions
      SET status = 'rejected', admin_comment = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending' AND photo_before IS NOT NULL AND photo_after IS NOT NULL`, [comment, submissionId]);
    if (result.changes === 0) throw Object.assign(new Error('Работа не найдена или уже проверена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/tickets', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const tickets = await all(`SELECT t.ticket_number, t.type, t.status, t.created_at,
        u.username, u.tg_id, u.current_cell
      FROM tickets t
      JOIN users u ON u.tg_id = t.tg_id
      ORDER BY t.ticket_number ASC`);
    res.json({ tickets });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/grant-ticket', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await get('SELECT tg_id, username FROM users WHERE tg_id = ?', [tgId]);
    if (!user) throw Object.assign(new Error('Игрок с таким Telegram ID не найден'), { status: 404 });
    const ticket = await issueTicket(tgId, 'standard');
    await addNewsEvent(`🎨 Красочка №${ticket.ticket_number} досталась ${formatUserHandle(user.username, user.tg_id)}!`, {
      eventType: 'manual_ticket',
      tgId: user.tg_id,
      ticketNumber: ticket.ticket_number
    });
    res.json({ ok: true, ticket });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/remove-ticket', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const ticketNumber = Number(req.body.ticket_number);
    if (!Number.isInteger(ticketNumber) || ticketNumber < 1) throw Object.assign(new Error('Некорректный номер Красочки'), { status: 400 });
    await run('DELETE FROM raffle_results WHERE ticket_number = ?', [ticketNumber]);
    const result = await run('DELETE FROM tickets WHERE ticket_number = ?', [ticketNumber]);
    if (result.changes === 0) throw Object.assign(new Error('Красочка не найдена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/tickets-export', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const tickets = await all(`SELECT t.ticket_number, t.type, t.created_at, u.username, u.tg_id, u.current_cell
      FROM tickets t
      JOIN users u ON u.tg_id = t.tg_id
      ORDER BY t.ticket_number ASC`);
    const draw = buildUniqueWinnerDraw(tickets);
    const lines = [
      `Всего выдано Красочек: ${tickets.length}`,
      `Уникальных претендентов: ${draw.winners.length}`,
      '',
      'Симуляция очереди победителей (один игрок может победить только один раз):',
      ...draw.winners.map((ticket, index) => `${index + 1}. №${ticket.ticket_number}${ticket.type === 'bonus' ? '★' : ''} — ${ticket.username || ticket.tg_id} — клетка ${ticket.current_cell}`),
      '',
      `Сгоревшие дубликаты после выбора победителей: ${draw.burnedTickets.length}`
    ];
    res.json({ tickets, winners: draw.winners, burnedTickets: draw.burnedTickets, text: lines.join('\n') });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/draw-winner', async (_req, res) => {
  res.status(410).json({ error: 'Ручной выбор победителя администратором отключен. Используйте Красочки игроков.' });
});

app.post('/api/admin/global-reset', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('DELETE FROM raffle_results');
    await run('DELETE FROM tickets');
    await run('DELETE FROM news_events');
    await run('DELETE FROM users WHERE tg_id <> ?', [OWNER_TG_ID]);
    await run('DELETE FROM sqlite_sequence WHERE name IN (?, ?, ?, ?)', ['submissions', 'tickets', 'raffle_results', 'news_events']);
    await run(`UPDATE raffle_config
      SET raffle_start = '', raffle_end = '', total_prizes = 0, remaining_prizes = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`);
    await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role)
      VALUES (?, 'Owner', 0, 1, 0, 'admin')
      ON CONFLICT(tg_id) DO UPDATE SET
        current_cell = 0,
        dice_frozen = 0,
        pending_lucky_cell = NULL,
        is_approved = 1,
        role = 'admin'`, [OWNER_TG_ID]);

    await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
    const entries = await fs.promises.readdir(UPLOADS_DIR);
    await Promise.all(entries.map((entry) => fs.promises.rm(path.join(UPLOADS_DIR, entry), { recursive: true, force: true })));

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Ошибка сервера' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Coloring Battle server started on port ${PORT}`)))
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
