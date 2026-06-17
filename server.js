import express from 'express';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const UPLOADS_DIR = '/data/uploads';
const DB_PATH = '/data/game.db';
const OWNER_TG_ID = '341995937';
const ADMIN_TG_IDS = new Set([
  OWNER_TG_ID,
  ...String(process.env.ADMIN_TG_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
]);

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
    role TEXT DEFAULT 'user',
    reactions_hearts INTEGER DEFAULT 0,
    reactions_coffee INTEGER DEFAULT 0,
    registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  await ensureUserTarotColumns();
  await ensureUserDuelColumns();
  await ensureUserGameCounterColumns();
  await ensureUserRoleColumn();
  await ensureUserReactionColumns();
  await ensureUserActivityColumns();
  await ensureReactionLogsTable();
  await ensureMapConfigTable();
  await ensureAccumulatingTicketsTable();
  await ensureRaffleConfigTable();
  await ensureRaffleResultsTable();
  await ensureNewsEventsTable();
  await ensurePuzzleDuelsTable();

  await run('CREATE INDEX IF NOT EXISTS idx_submissions_player_status ON submissions(tg_id, status, task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_pending_images ON submissions(status, image_name)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_pending_photos ON submissions(status, photo_before, photo_after)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_tg_id ON tickets(tg_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_status_random ON tickets(status, ticket_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_raffle_results_place ON raffle_results(place_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_raffle_results_ticket ON raffle_results(ticket_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_news_events_created ON news_events(created_at, id)');
  await run('CREATE INDEX IF NOT EXISTS idx_news_events_tg_id ON news_events(tg_id, id)');
  await run('CREATE INDEX IF NOT EXISTS idx_puzzle_duels_players_status ON puzzle_duels(challenger_tg_id, opponent_tg_id, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_reaction_logs_limit ON reaction_logs(from_tg_id, to_tg_id, reacted_at)');

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
  await loadMapConfig();
}


async function ensureMapConfigTable() {
  await run(`CREATE TABLE IF NOT EXISTS map_config (
    cell INTEGER PRIMARY KEY,
    cell_type TEXT NOT NULL CHECK(cell_type IN ('trap', 'lucky')),
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const count = await get('SELECT COUNT(*) AS count FROM map_config');
  if (Number(count?.count || 0) !== 14) {
    await regenerateMapConfig();
  }
}

function pickRandomCells(count, excluded = new Set()) {
  const cells = [];
  while (cells.length < count) {
    const cell = crypto.randomInt(1, 100);
    if (excluded.has(cell) || cells.includes(cell)) continue;
    cells.push(cell);
  }
  return cells;
}

async function regenerateMapConfig() {
  const used = new Set();
  const trapCells = pickRandomCells(7, used);
  trapCells.forEach((cell) => used.add(cell));
  const luckyCells = pickRandomCells(7, used);

  await run('DELETE FROM map_config');
  for (const cell of trapCells) {
    await run("INSERT INTO map_config (cell, cell_type) VALUES (?, 'trap')", [cell]);
  }
  for (const cell of luckyCells) {
    await run("INSERT INTO map_config (cell, cell_type) VALUES (?, 'lucky')", [cell]);
  }
  return { trapCells, luckyCells };
}

async function loadMapConfig() {
  const rows = await all('SELECT cell, cell_type FROM map_config');
  TRAP_CELLS = new Set(rows.filter((row) => row.cell_type === 'trap').map((row) => Number(row.cell)));
  LUCKY_CELLS = new Set(rows.filter((row) => row.cell_type === 'lucky').map((row) => Number(row.cell)));
}

async function ensureUserTarotColumns() {
  const columns = await all('PRAGMA table_info(users)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('has_used_tarot')) {
    await run('ALTER TABLE users ADD COLUMN has_used_tarot INTEGER DEFAULT 0');
  }
  if (!names.has('trap_immunity')) {
    await run('ALTER TABLE users ADD COLUMN trap_immunity INTEGER DEFAULT 0');
  }
  if (!names.has('next_roll_halved')) {
    await run('ALTER TABLE users ADD COLUMN next_roll_halved INTEGER DEFAULT 0');
  }
}

async function ensureUserDuelColumns() {
  const columns = await all('PRAGMA table_info(users)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('can_challenge')) await run('ALTER TABLE users ADD COLUMN can_challenge INTEGER DEFAULT 1');
  if (!names.has('can_accept')) await run('ALTER TABLE users ADD COLUMN can_accept INTEGER DEFAULT 1');
}

async function ensureUserGameCounterColumns() {
  const columns = await all('PRAGMA table_info(users)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('penalty_rerolls')) await run('ALTER TABLE users ADD COLUMN penalty_rerolls INTEGER DEFAULT 0');
  if (!names.has('total_dice_rolls')) await run('ALTER TABLE users ADD COLUMN total_dice_rolls INTEGER DEFAULT 0');
}

async function ensureUserRoleColumn() {
  const columns = await all('PRAGMA table_info(users)');
  if (!columns.some((column) => column.name === 'role')) {
    await run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
  }
  await run("UPDATE users SET role = 'admin', is_approved = 1 WHERE tg_id = ?", [OWNER_TG_ID]);
}


async function ensureUserReactionColumns() {
  const columns = await all('PRAGMA table_info(users)');
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('reactions_hearts')) {
    await run('ALTER TABLE users ADD COLUMN reactions_hearts INTEGER DEFAULT 0');
  }
  if (!columnNames.has('reactions_coffee')) {
    await run('ALTER TABLE users ADD COLUMN reactions_coffee INTEGER DEFAULT 0');
  }
}

async function ensureUserActivityColumns() {
  const columns = await all('PRAGMA table_info(users)');
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has('registered_at')) {
    await run('ALTER TABLE users ADD COLUMN registered_at TEXT');
  }
  if (!columnNames.has('last_login_at')) {
    await run('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  }
  await run('UPDATE users SET registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP), last_login_at = COALESCE(last_login_at, registered_at, CURRENT_TIMESTAMP)');
}

async function ensureReactionLogsTable() {
  await run(`CREATE TABLE IF NOT EXISTS reaction_logs (
    from_tg_id TEXT,
    to_tg_id TEXT,
    reaction_type TEXT,
    reacted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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
  const existing = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raffle_results'");
  const desiredSql = `CREATE TABLE raffle_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_number INTEGER NOT NULL UNIQUE,
    ticket_number INTEGER NOT NULL UNIQUE,
    tg_id TEXT NOT NULL,
    username TEXT DEFAULT '',
    drawn_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_number) REFERENCES tickets(ticket_number),
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  )`;

  if (!existing) {
    await run(desiredSql);
    return;
  }

  const columns = await all('PRAGMA table_info(raffle_results)');
  const columnNames = new Set(columns.map((column) => column.name));
  const hasPlaceNumber = columnNames.has('place_number');
  const hasTicketNumber = columnNames.has('ticket_number');

  if (hasPlaceNumber && hasTicketNumber && String(existing.sql || '').toLowerCase().includes('place_number integer not null unique')) return;

  await run('ALTER TABLE raffle_results RENAME TO raffle_results_old');
  await run(desiredSql);
  const ticketExpression = hasTicketNumber ? 'ticket_number' : 'ticket_id';
  await run(`INSERT OR IGNORE INTO raffle_results (place_number, ticket_number, tg_id, username, drawn_at)
    SELECT ROW_NUMBER() OVER (ORDER BY COALESCE(drawn_at, CURRENT_TIMESTAMP), id),
      ${ticketExpression}, tg_id, COALESCE(username, ''), COALESCE(drawn_at, CURRENT_TIMESTAMP)
    FROM raffle_results_old
    WHERE ${ticketExpression} IS NOT NULL AND tg_id IS NOT NULL
    ORDER BY COALESCE(drawn_at, CURRENT_TIMESTAMP), id`);
  await run('DROP TABLE raffle_results_old');
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

async function ensurePuzzleDuelsTable() {
  await run(`CREATE TABLE IF NOT EXISTS puzzle_duels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenger_tg_id TEXT NOT NULL,
    opponent_tg_id TEXT NOT NULL,
    challenger_time REAL,
    opponent_time REAL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'challenger_won', 'opponent_won', 'declined', 'expired')),
    winner_tg_id TEXT DEFAULT '',
    loser_tg_id TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (challenger_tg_id) REFERENCES users(tg_id),
    FOREIGN KEY (opponent_tg_id) REFERENCES users(tg_id)
  )`);
}

async function finishPuzzleDuel(duel, winnerTgId, loserTgId, status) {
  await run(`UPDATE puzzle_duels
    SET status = ?, winner_tg_id = ?, loser_tg_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`, [status, winnerTgId, loserTgId, duel.id]);
  const ticket = await issueTicket(winnerTgId, 'bonus');
  await addNewsEvent('🧩 Да ты не только мастер рисовать, но еще и мегамозг! Дуэль выиграна, лови приз!', { eventType: 'puzzle_duel_win', tgId: winnerTgId, ticketNumber: ticket.ticket_number });
  await addNewsEvent('🧩 Не выиграла дуэль, зато ты красишь круто!', { eventType: 'puzzle_duel_loss', tgId: loserTgId });
  return ticket;
}

async function expirePuzzleDuels() {
  const expired = await all(`SELECT * FROM puzzle_duels
    WHERE status IN ('pending', 'active') AND datetime(created_at, '+24 hours') <= datetime('now')
    LIMIT 50`);
  for (const duel of expired) await finishPuzzleDuel(duel, duel.challenger_tg_id, duel.opponent_tg_id, 'expired');
}

async function seedTasks() {
  const rawTasks = `1. Раскрась кадр из мультфильма, используя только оттенки серого (эффект старого кино)
2. Её волосы светятся, когда она поет (Ответ - кодовое слово и задача на этап)
3. Раскрась Малефисенту в радужных, добрых тонах (Ответ - кодовое слово и задача на этап)
4. 🧊 + ❄️ + 👑  (Ответ - кодовое слово и задача на этап)
5. Маленькая деревянная кукла с растущим носом (Ответ - кодовое слово и задача на этап)
6. 🍳 + 🦎 + 👑  (Ответ - кодовое слово и задача на этап)
7. 🎸 + 💀 (Ответ - кодовое слово и задача на этап)
8. Нарисуй любого персонажа Disney в стиле аниме (Аниме - кодовое слово и задача на этап)
9. Очень важно пробовать новое! Время нарисовать фломастерную работу. У тебя получится! (Фломик - кодовое слово и задача на этап)
10. 🕰 + 🕯 + ☕️ + 🏰 Твоя задача - сцена из мульфильма с присутствием загаданных персонажей
11. Раскрась персонажа, используя только «комплементарную триаду» цветового круга (например, фиолетовый, оранжевый и зеленый). (Триада - кодовое слово и задача на этап)
12. 🧪 + 🎩 + 🐰 + ☕️ (Ответ - кодовое слово и задача на этап)
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
37. 🐭 + 🔴 + 🎀 (Ответ - кодовое слово и задача на этап)
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
48. «Тайное послание»: Напиши на странице №10 первую букву своего имени и обведи её в сердечко. (Наименование задания - кодовое слово, рисуй, что нравится)
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
  updates.push('last_login_at = CURRENT_TIMESTAMP');
  if (updates.length) {
    params.push(tgId);
    await run(`UPDATE users SET ${updates.join(', ')} WHERE tg_id = ?`, params);
  }
  return get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
}

async function createOrRefreshApplication(tgId, username = '') {
  const role = ADMIN_TG_IDS.has(String(tgId)) ? 'admin' : 'user';
  const approved = role === 'admin' ? 1 : 0;
  await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role, registered_at, last_login_at)
    VALUES (?, ?, 0, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tg_id) DO UPDATE SET
      username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE users.username END,
      role = CASE WHEN users.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE users.role END,
      is_approved = CASE WHEN users.role = 'admin' OR excluded.role = 'admin' THEN 1 ELSE users.is_approved END,
      last_login_at = CURRENT_TIMESTAMP`,
    [tgId, username, approved, role]);
  return get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
}

async function requireApproved(tgId) {
  const user = await get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
  if (!user) throw Object.assign(new Error('Игрок не найден. Подайте заявку на участие.'), { status: 404 });
  if (Number(user.is_approved) !== 1) throw Object.assign(new Error('Игрок еще не одобрен администратором'), { status: 403 });
  return user;
}

function isPrivilegedRole(user) {
  return user?.role === 'admin' || user?.role === 'moderator';
}

function assertPlayableUser(user) {
  if (isPrivilegedRole(user) || ADMIN_TG_IDS.has(String(user?.tg_id || ''))) {
    throw Object.assign(new Error('Игровой процесс для администратора/модератора недоступен'), { status: 403 });
  }
}

async function requireAdmin(tgId) {
  const normalized = normalizeTgId(tgId);
  if (!ADMIN_TG_IDS.has(normalized)) {
    throw Object.assign(new Error('Доступ только для главного администратора'), { status: 403 });
  }
  await createOrRefreshApplication(normalized, 'Owner');
  return requireApproved(normalized);
}

async function requireModeratorOrAdmin(tgId) {
  const normalized = normalizeTgId(tgId);
  if (ADMIN_TG_IDS.has(normalized)) {
    await createOrRefreshApplication(normalized, 'Owner');
  }
  const user = await requireApproved(normalized);
  if (!isPrivilegedRole(user)) {
    throw Object.assign(new Error('Доступ только для администратора или модератора'), { status: 403 });
  }
  return user;
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
  return all(`WITH numbered_tickets AS (
      SELECT t.ticket_number, t.type, t.status, t.created_at, r.place_number,
        ROW_NUMBER() OVER (PARTITION BY t.tg_id, t.type ORDER BY t.ticket_number ASC) AS ticket_order
      FROM tickets t
      LEFT JOIN raffle_results r ON r.ticket_number = t.ticket_number
      WHERE t.tg_id = ?
    ), numbered_works AS (
      SELECT s.id AS submission_id, s.cell, s.photo_before, s.photo_after, s.photo_after AS source,
        '/uploads/' || s.photo_after AS image_url, s.status AS submission_status,
        s.updated_at, task.text_task,
        ROW_NUMBER() OVER (PARTITION BY s.tg_id ORDER BY s.id ASC) AS work_order
      FROM submissions s
      JOIN tasks task ON task.id = s.task_id
      WHERE s.tg_id = ? AND s.status = 'approved'
    )
    SELECT nt.ticket_number, nt.type, nt.status, nt.created_at, nt.place_number,
      nw.submission_id, nw.cell, nw.text_task, nw.photo_before, nw.photo_after, nw.source, nw.image_url, nw.submission_status
    FROM numbered_tickets nt
    LEFT JOIN numbered_works nw ON nt.type = 'standard' AND nw.work_order = nt.ticket_order
    ORDER BY nt.ticket_number ASC`, [tgId, tgId]);
}

let TRAP_CELLS = new Set([13, 26, 39, 52, 65, 78, 91]);
let LUCKY_CELLS = new Set([7, 21, 35, 49, 63, 77, 88]);
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
  return crypto.randomInt(1, 7);
}

const TAROT_CARDS = [
  { id: 'double_roll', title: 'Золотая кисть Рапунцель', icon: '🖌️', kind: 'buff', description: 'Х2 к следующему шагу: два броска подряд складываются.' },
  { id: 'trap_immunity', title: 'Защитное яблоко Белоснежки', icon: '🍎', kind: 'buff', description: 'Единоразовый иммунитет от будущей ловушки.' },
  { id: 'halve_next_roll', title: 'Высохший маркер Шрама', icon: '🖊️', kind: 'curse', description: 'Следующий бросок кубика делится пополам.' }
];

function shuffleTarotCards() {
  const cards = TAROT_CARDS.map((card) => ({ ...card }));
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
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
    remaining_prizes: Math.max(0, Number(config?.total_prizes || 0) - Number(results?.length || 0)),
    is_sold_out: Number(results?.length || 0) >= Number(config?.total_prizes || 0) && Number(config?.total_prizes || 0) > 0
  };
}

async function scratchTicket({ tgId, ticketNumber }) {
  const user = await requireApproved(tgId);
  assertPlayableUser(user);
  await run('BEGIN IMMEDIATE TRANSACTION');
  let winningEvent = null;
  try {
    const config = await getRaffleConfig();
    const windowState = buildRaffleWindow(config);
    if (!windowState.is_active) {
      throw Object.assign(new Error('Красочки сейчас недоступны: проверьте время старта и финиша'), { status: 403 });
    }

    const totalPrizes = Number(config?.total_prizes || 0);
    const awarded = await get('SELECT COUNT(*) AS count FROM raffle_results');
    const awardedCount = Number(awarded?.count || 0);
    if (totalPrizes <= 0 || awardedCount >= totalPrizes) {
      throw Object.assign(new Error('Лотерея завершена, все призы разыграны'), { status: 410 });
    }

    const ticket = await get(`SELECT ticket_number, tg_id, type, status
      FROM tickets
      WHERE ticket_number = ? AND tg_id = ?`, [ticketNumber, tgId]);
    if (!ticket) throw Object.assign(new Error('Красочка не найдена у текущего игрока'), { status: 404 });
    if (ticket.status !== 'active') throw Object.assign(new Error('Эта Красочка уже стерта'), { status: 400 });

    const counters = await get(`SELECT COUNT(*) AS active_tickets FROM tickets WHERE status = 'active'`);
    const activeTickets = Number(counters?.active_tickets || 0);
    const remainingPrizes = Math.max(0, totalPrizes - awardedCount);
    if (activeTickets <= 0) throw Object.assign(new Error('Активных Красочек не осталось'), { status: 400 });

    const wins = remainingPrizes >= activeTickets || crypto.randomInt(activeTickets) < remainingPrizes;

    if (wins) {
      const placeNumber = awardedCount + 1;
      await run("UPDATE tickets SET status = 'winner' WHERE ticket_number = ? AND status = 'active'", [ticketNumber]);
      await run(`UPDATE raffle_config
        SET remaining_prizes = MAX(total_prizes - ?, 0), updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`, [placeNumber]);
      const inserted = await run(`INSERT INTO raffle_results (place_number, ticket_number, tg_id, username)
        VALUES (?, ?, ?, ?)`, [placeNumber, ticketNumber, tgId, user.username || '']);
      winningEvent = {
        id: inserted.id,
        place_number: placeNumber,
        ticket_number: ticketNumber,
        tg_id: tgId,
        username: user.username || '',
        drawn_at: new Date().toISOString()
      };
      await run('COMMIT');

      await addNewsEvent(`🏆 Место №${placeNumber} — Красочка номер ${ticketNumber}, игрок ${formatUserHandle(user.username, user.tg_id)}`, {
        eventType: 'scratch_win',
        tgId: user.tg_id,
        ticketNumber
      });

      return { result: 'win', winner: winningEvent };
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
    const tickets = Number(user.is_approved) === 1 && !isPrivilegedRole(user) ? await getPlayerTickets(tgId) : [];
    const pendingLucky = Number(user.is_approved) === 1 && user.pending_lucky_cell !== null
      ? { cell: Number(user.pending_lucky_cell), options: LUCKY_TASK_OPTIONS }
      : null;
    res.json({ user: { ...user, has_used_tarot: Number(user.has_used_tarot) === 1, trap_immunity: Number(user.trap_immunity) === 1, next_roll_halved: Number(user.next_roll_halved) === 1, penalty_rerolls: Number(user.penalty_rerolls || 0), total_dice_rolls: Number(user.total_dice_rolls || 0) }, activeSubmission, pendingLucky, tickets, needs_application: false, is_finalist: Number(user.current_cell) >= 100, is_admin: user.role === 'admin', is_moderator: user.role === 'moderator' });
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


app.get('/api/game/leaderboard', async (_req, res, next) => {
  try {
    const players = await all(`SELECT u.tg_id, u.username, u.current_cell, u.reactions_hearts, u.reactions_coffee,
        COUNT(DISTINCT t.ticket_number) AS tickets_count,
        MIN(CASE WHEN s.status = 'approved' THEN s.updated_at END) AS first_approved_at,
        MAX(CASE WHEN s.status = 'approved' THEN s.updated_at END) AS last_approved_at
      FROM users u
      LEFT JOIN tickets t ON t.tg_id = u.tg_id
      LEFT JOIN submissions s ON s.tg_id = u.tg_id
      WHERE u.is_approved = 1
        AND u.tg_id <> ?
        AND COALESCE(u.role, 'user') NOT IN ('moderator', 'admin')
      GROUP BY u.tg_id
      ORDER BY tickets_count DESC, COALESCE(last_approved_at, '9999-12-31') ASC, u.current_cell DESC, u.username COLLATE NOCASE ASC, u.tg_id ASC`, [OWNER_TG_ID]);
    res.json({ players });
  } catch (error) {
    next(error);
  }
});


app.get('/api/profile/:tgId', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.params.tgId);
    const user = await get(`SELECT tg_id, username, current_cell, is_approved, dice_frozen
      FROM users WHERE tg_id = ? AND is_approved = 1`, [tgId]);
    if (!user) throw Object.assign(new Error('Профиль не найден'), { status: 404 });
    const works = await all(`SELECT s.id, s.task_id, s.cell, s.status, s.photo_before, s.photo_after, s.updated_at, t.text_task
      FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.tg_id = ? AND s.status = 'approved' AND s.photo_after IS NOT NULL
      ORDER BY s.updated_at DESC`, [tgId]);
    const tickets = await getPlayerTickets(tgId);
    const counts = await get(`SELECT COUNT(*) AS paints FROM tickets WHERE tg_id = ?`, [tgId]);
    res.json({ profile: { name: user.username || `ID ${user.tg_id}`, tg_id: user.tg_id, current_cell: user.current_cell, paints: Number(counts?.paints || 0), local_status: Number(user.dice_frozen) === 1 ? 'Ждет проверку' : 'Готов к броску', tickets, works } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/react', async (req, res, next) => {
  try {
    const fromTgId = normalizeTgId(req.body.from_tg_id);
    const toTgId = normalizeTgId(req.body.to_tg_id);
    const reactionType = String(req.body.reaction_type || '').trim();

    if (!['heart', 'coffee'].includes(reactionType)) {
      throw Object.assign(new Error('Неизвестный тип реакции'), { status: 400 });
    }
    if (fromTgId === toTgId) {
      throw Object.assign(new Error('Нельзя поддерживать самого себя'), { status: 400 });
    }

    const fromUser = await requireApproved(fromTgId);
    assertPlayableUser(fromUser);
    const toUser = await requireApproved(toTgId);
    assertPlayableUser(toUser);

    const recentReaction = await get(`SELECT reacted_at
      FROM reaction_logs
      WHERE from_tg_id = ? AND to_tg_id = ? AND reacted_at >= datetime('now', '-24 hours')
      LIMIT 1`, [fromTgId, toTgId]);

    if (recentReaction) {
      res.status(429).json({
        success: false,
        message: 'Вы уже поддерживали этого игрока за последние 24 часа! Можно поставить только 1 реакцию (сердце или кофе) в сутки.'
      });
      return;
    }

    const column = reactionType === 'heart' ? 'reactions_hearts' : 'reactions_coffee';
    await run(`UPDATE users SET ${column} = COALESCE(${column}, 0) + 1 WHERE tg_id = ?`, [toTgId]);
    await run('INSERT INTO reaction_logs (from_tg_id, to_tg_id, reaction_type) VALUES (?, ?, ?)', [fromTgId, toTgId, reactionType]);

    const updatedUser = await get('SELECT tg_id, username, current_cell, reactions_hearts, reactions_coffee FROM users WHERE tg_id = ?', [toTgId]);
    const newCount = Number(updatedUser?.[column] || 0);
    let bonusTicket = null;

    if (newCount > 0 && newCount % 50 === 0) {
      bonusTicket = await issueTicket(toTgId, 'bonus');
      const handle = formatUserHandle(updatedUser.username, updatedUser.tg_id);
      const message = reactionType === 'heart'
        ? `🎉 Потрясающе! ${handle} накопил ${newCount} сердечек от девчонок и получает бонусную Красочку №${bonusTicket.ticket_number}!`
        : `☕️ Какая поддержка! ${handle} получил уже ${newCount} чашек кофе от клуба и награждается бонусной Красочкой №${bonusTicket.ticket_number}!`;
      await addNewsEvent(message, { eventType: `reaction_${reactionType}_bonus`, tgId: toTgId, ticketNumber: bonusTicket.ticket_number });
    }

    res.json({ success: true, player: updatedUser, bonus_ticket: bonusTicket });
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

async function applyMoveAndCreateTask(tgId, user, dice, extra = {}) {
  const landedCell = Math.min(100, Number(user.current_cell || 0) + dice);
  const cellType = getCellType(landedCell);

  if (cellType === 'lucky') {
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = ?, next_roll_halved = 0, total_dice_rolls = COALESCE(total_dice_rolls, 0) + 1 WHERE tg_id = ?', [landedCell, landedCell, tgId]);
    return { ok: true, dice, current_cell: landedCell, cell_type: cellType, lucky_options: LUCKY_TASK_OPTIONS, ...extra };
  }

  let currentCell = landedCell;
  let trapDice = null;
  let trapImmunityUsed = false;
  if (cellType === 'trap') {
    if (Number(user.trap_immunity) === 1) {
      trapImmunityUsed = true;
      await run('UPDATE users SET trap_immunity = 0 WHERE tg_id = ?', [tgId]);
    } else {
      trapDice = rollD6();
      currentCell = Math.max(0, landedCell - trapDice);
    }
  }

  const pending = await createPendingSubmissionForCell(tgId, currentCell);
  await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL, next_roll_halved = 0, total_dice_rolls = COALESCE(total_dice_rolls, 0) + 1 WHERE tg_id = ?', [currentCell, tgId]);
  return { ok: true, dice, trap_dice: trapDice, trap_immunity_used: trapImmunityUsed, landed_cell: landedCell, current_cell: currentCell, cell_type: cellType, ...extra, ...pending };
}

app.post('/api/roll', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    assertPlayableUser(user);
    if (Number(user.dice_frozen) === 1) throw Object.assign(new Error('Кубик заморожен до проверки задания'), { status: 400 });
    if (Number(user.current_cell) >= 100) throw Object.assign(new Error('Вы уже дошли до финиша'), { status: 400 });

    const rawDice = rollD6();
    const dice = Number(user.next_roll_halved) === 1 ? Math.max(1, Math.ceil(rawDice / 2)) : rawDice;
    res.json(await applyMoveAndCreateTask(tgId, user, dice, { raw_dice: rawDice, roll_halved: Number(user.next_roll_halved) === 1 }));
  } catch (error) {
    next(error);
  }
});


app.get('/api/notifications/:userId', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.params.userId);
    await requireApproved(tgId);
    const limit = Math.max(1, Math.min(40, Number(req.query.limit) || 25));
    const events = await all(`SELECT id, message, event_type, created_at FROM news_events WHERE tg_id = ? ORDER BY id DESC LIMIT ?`, [tgId, limit]);
    const submissions = await all(`SELECT id, cell, status, updated_at AS created_at FROM submissions WHERE tg_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10`, [tgId]);
    const duels = await all(`SELECT id, challenger_tg_id, opponent_tg_id, challenger_time, opponent_time, status, winner_tg_id, loser_tg_id, updated_at AS created_at FROM puzzle_duels WHERE challenger_tg_id = ? OR opponent_tg_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10`, [tgId, tgId]);
    res.json({ events, submissions, duels });
  } catch (error) { next(error); }
});

app.get('/api/duels/players', async (req, res, next) => {
  try {
    await expirePuzzleDuels();
    const tgId = normalizeTgId(req.query.tg_id);
    await requireApproved(tgId);
    const players = await all(`SELECT tg_id, username FROM users WHERE tg_id <> ? AND is_approved = 1 AND role = 'user' AND can_challenge = 1 AND can_accept = 1 ORDER BY username COLLATE NOCASE ASC, tg_id ASC LIMIT 80`, [tgId]);
    const active = await get(`SELECT * FROM puzzle_duels WHERE (challenger_tg_id = ? OR opponent_tg_id = ?) AND status IN ('pending', 'active') ORDER BY id DESC LIMIT 1`, [tgId, tgId]);
    res.json({ players, active_duel: active || null });
  } catch (error) { next(error); }
});

app.post('/api/duels/challenge', async (req, res, next) => {
  try {
    await expirePuzzleDuels();
    const tgId = normalizeTgId(req.body.tg_id);
    const opponentId = normalizeTgId(req.body.opponent_tg_id);
    if (tgId === opponentId) throw Object.assign(new Error('Нельзя вызвать саму себя'), { status: 400 });
    const user = await requireApproved(tgId);
    const opponent = await requireApproved(opponentId);
    assertPlayableUser(user); assertPlayableUser(opponent);
    if (Number(user.can_challenge) !== 1) throw Object.assign(new Error('Вызов уже использован в этой игре'), { status: 400 });
    if (Number(opponent.can_accept) !== 1) throw Object.assign(new Error('Этот игрок уже принимал дуэль'), { status: 400 });
    const existing = await get(`SELECT id FROM puzzle_duels WHERE (challenger_tg_id = ? OR opponent_tg_id = ? OR challenger_tg_id = ? OR opponent_tg_id = ?) AND status IN ('pending', 'active') LIMIT 1`, [tgId, tgId, opponentId, opponentId]);
    if (existing) throw Object.assign(new Error('У одного из игроков уже есть активная дуэль'), { status: 400 });
    const result = await run(`INSERT INTO puzzle_duels (challenger_tg_id, opponent_tg_id, status) VALUES (?, ?, 'pending')`, [tgId, opponentId]);
    await run('UPDATE users SET can_challenge = 0 WHERE tg_id = ?', [tgId]);
    await run('UPDATE users SET can_accept = 0 WHERE tg_id = ?', [opponentId]);
    await addNewsEvent(`🧩 ${formatUserHandle(user.username, user.tg_id)} вызывает ${formatUserHandle(opponent.username, opponent.tg_id)} на дуэль в пятнашки!`, { eventType: 'puzzle_duel_challenge', tgId: opponentId });
    res.json({ ok: true, duel: await get('SELECT * FROM puzzle_duels WHERE id = ?', [result.id]) });
  } catch (error) { next(error); }
});

app.post('/api/duels/decline', async (req, res, next) => {
  try {
    await expirePuzzleDuels();
    const tgId = normalizeTgId(req.body.tg_id);
    const duelId = Number(req.body.duel_id);
    const duel = await get("SELECT * FROM puzzle_duels WHERE id = ? AND status IN ('pending', 'active')", [duelId]);
    if (!duel) throw Object.assign(new Error('Дуэль не найдена'), { status: 404 });
    if (duel.opponent_tg_id !== tgId) throw Object.assign(new Error('Отклонить может только соперник'), { status: 403 });
    const ticket = await finishPuzzleDuel(duel, duel.challenger_tg_id, duel.opponent_tg_id, 'declined');
    res.json({ ok: true, ticket });
  } catch (error) { next(error); }
});

app.post('/api/duels/submit', async (req, res, next) => {
  try {
    await expirePuzzleDuels();
    const tgId = normalizeTgId(req.body.tg_id);
    const duelId = Number(req.body.duel_id);
    const seconds = Math.max(1, Math.min(3600, Number(req.body.seconds)));
    const duel = await get("SELECT * FROM puzzle_duels WHERE id = ? AND status IN ('pending', 'active')", [duelId]);
    if (!duel) throw Object.assign(new Error('Дуэль не найдена или уже закрыта'), { status: 404 });
    if (![duel.challenger_tg_id, duel.opponent_tg_id].includes(tgId)) throw Object.assign(new Error('Это не ваша дуэль'), { status: 403 });
    const field = tgId === duel.challenger_tg_id ? 'challenger_time' : 'opponent_time';
    if (duel[field] !== null && duel[field] !== undefined) throw Object.assign(new Error('Ваш результат уже отправлен'), { status: 400 });
    await run(`UPDATE puzzle_duels SET ${field} = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [seconds, duelId]);
    const updated = await get('SELECT * FROM puzzle_duels WHERE id = ?', [duelId]);
    if (updated.challenger_time !== null && updated.opponent_time !== null) {
      const challengerWins = Number(updated.challenger_time) <= Number(updated.opponent_time);
      const winner = challengerWins ? updated.challenger_tg_id : updated.opponent_tg_id;
      const loser = challengerWins ? updated.opponent_tg_id : updated.challenger_tg_id;
      const ticket = await finishPuzzleDuel(updated, winner, loser, challengerWins ? 'challenger_won' : 'opponent_won');
      res.json({ ok: true, duel: await get('SELECT * FROM puzzle_duels WHERE id = ?', [duelId]), ticket });
      return;
    }
    res.json({ ok: true, duel: updated });
  } catch (error) { next(error); }
});

app.post('/api/tarot', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const selectedIndex = Number(req.body.selected_index);
    const user = await requireApproved(tgId);
    assertPlayableUser(user);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 2) throw Object.assign(new Error('Выберите одну из трех карт'), { status: 400 });
    if (Number(user.has_used_tarot) === 1) throw Object.assign(new Error('Карта удачи уже использована в этой игре'), { status: 400 });
    if (Number(user.dice_frozen) === 1) throw Object.assign(new Error('Сначала завершите текущее задание'), { status: 400 });
    if (Number(user.current_cell) >= 100) throw Object.assign(new Error('Вы уже дошли до финиша'), { status: 400 });

    const deck = shuffleTarotCards();
    const selectedCard = deck[selectedIndex];
    await run('UPDATE users SET has_used_tarot = 1 WHERE tg_id = ?', [tgId]);

    const tarotExtra = { tarot_card: selectedCard.title, tarot_effect: selectedCard.id, tarot_deck: deck, selected_index: selectedIndex };
    if (selectedCard.id === 'double_roll') {
      const dice_rolls = [rollD6(), rollD6()];
      const dice = dice_rolls[0] + dice_rolls[1];
      const freshUser = await get('SELECT * FROM users WHERE tg_id = ?', [tgId]);
      res.json(await applyMoveAndCreateTask(tgId, freshUser, dice, { ...tarotExtra, dice_rolls }));
      return;
    }
    if (selectedCard.id === 'trap_immunity') {
      await run('UPDATE users SET trap_immunity = 1 WHERE tg_id = ?', [tgId]);
      res.json({ ok: true, ...tarotExtra, trap_immunity: true });
      return;
    }
    await run('UPDATE users SET next_roll_halved = 1 WHERE tg_id = ?', [tgId]);
    res.json({ ok: true, ...tarotExtra });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reroll-task', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    assertPlayableUser(user);
    const active = await getActiveSubmission(tgId);
    if (!active || active.status !== 'pending' || active.photo_before || active.photo_after) {
      throw Object.assign(new Error('Сменить можно только новое задание до загрузки фото'), { status: 400 });
    }
    if (getCellType(active.cell) !== 'ordinary') throw Object.assign(new Error('На этой клетке смена задания недоступна'), { status: 400 });

    if (Number(user.penalty_rerolls || 0) >= 3) {
      throw Object.assign(new Error('Твой лимит штрафных перебросов исчерпан (3 из 3). Пришло время брать материалы и рисовать выпавшее задание! 🎨✨'), { status: 400 });
    }
    const penalty = Math.floor(Math.random() * 3) + 1;
    const currentCell = Math.max(0, Number(user.current_cell || 0) - penalty);
    await run('DELETE FROM submissions WHERE id = ?', [active.id]);
    const pending = await createPendingSubmissionForCell(tgId, currentCell);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL, next_roll_halved = 0, penalty_rerolls = COALESCE(penalty_rerolls, 0) + 1 WHERE tg_id = ?', [currentCell, tgId]);

    res.json({ ok: true, penalty, current_cell: currentCell, penalty_rerolls: Number(user.penalty_rerolls || 0) + 1, penalty_rerolls_limit: 3, ...pending });
  } catch (error) {
    next(error);
  }
});

app.post('/api/lucky-choice', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    assertPlayableUser(user);
    const choice = String(req.body.choice || '').trim();
    if (!LUCKY_TASK_OPTIONS.includes(choice)) throw Object.assign(new Error('Выберите один из бонусных вариантов'), { status: 400 });
    const luckyCell = Number(user.pending_lucky_cell);
    if (!Number.isInteger(luckyCell) || getCellType(luckyCell) !== 'lucky') throw Object.assign(new Error('Бонусная клетка не ожидает выбора'), { status: 400 });

    const result = await run('INSERT OR IGNORE INTO tasks (text_task) VALUES (?)', [choice]);
    const task = result.id ? await get('SELECT id, text_task FROM tasks WHERE id = ?', [result.id]) : await get('SELECT id, text_task FROM tasks WHERE text_task = ?', [choice]);
    const submission = await run('INSERT INTO submissions (tg_id, cell, task_id, status) VALUES (?, ?, ?, ?)', [tgId, luckyCell, task.id, 'pending']);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1, pending_lucky_cell = NULL, next_roll_halved = 0 WHERE tg_id = ?', [luckyCell, tgId]);

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
    const user = await requireApproved(tgId);
    assertPlayableUser(user);

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
    assertPlayableUser(user);
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
    await requireModeratorOrAdmin(req.query.admin_tg_id);
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
    await requireModeratorOrAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    const result = await run('UPDATE users SET is_approved = 1, current_cell = 0, dice_frozen = 0, pending_lucky_cell = NULL, has_used_tarot = 0, trap_immunity = 0, next_roll_halved = 0, penalty_rerolls = 0, total_dice_rolls = 0 WHERE tg_id = ?', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Заявка не найдена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reject-user', async (req, res, next) => {
  try {
    await requireModeratorOrAdmin(req.body.admin_tg_id);
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
    const user = await get('SELECT tg_id, username FROM users WHERE tg_id = ?', [tgId]);
    await addNewsEvent(`🔧 Модератор переместил игрока ${formatUserHandle(user?.username, tgId)} на клетку ${currentCell}`, {
      eventType: 'admin_change_cell',
      tgId,
      ticketNumber: null
    });
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
    await requireModeratorOrAdmin(req.query.admin_tg_id);
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


app.get('/api/admin/work-archive', async (req, res, next) => {
  try {
    await requireModeratorOrAdmin(req.query.admin_tg_id);
    const players = await all(`SELECT u.tg_id, u.username, u.current_cell, u.dice_frozen,
        (SELECT COUNT(*) FROM submissions approved WHERE approved.tg_id = u.tg_id AND approved.status = 'approved') AS approved_submissions_count,
        (SELECT COUNT(*) FROM tickets active_ticket WHERE active_ticket.tg_id = u.tg_id AND active_ticket.status = 'active') AS active_tickets_count
      FROM users u
      WHERE u.is_approved = 1 AND COALESCE(u.role, 'user') = 'user'
      ORDER BY u.current_cell DESC, u.username COLLATE NOCASE ASC, u.tg_id ASC`);

    const works = await all(`SELECT s.id, s.tg_id, s.cell, s.photo_before, s.photo_after, s.updated_at, t.text_task
      FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'approved' AND s.photo_before IS NOT NULL AND s.photo_after IS NOT NULL
      ORDER BY s.cell ASC, s.updated_at DESC, s.id DESC`);

    const byId = new Map(players.map((player) => [player.tg_id, { ...player, works: [] }]));
    for (const work of works) {
      byId.get(work.tg_id)?.works.push(work);
    }

    res.json({ players: Array.from(byId.values()) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/toggle-moderator', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const targetTgId = normalizeTgId(req.body.target_tg_id);
    if (targetTgId === OWNER_TG_ID) throw Object.assign(new Error('Главный администратор уже имеет полные права'), { status: 400 });

    const user = await get('SELECT tg_id, username, role FROM users WHERE tg_id = ?', [targetTgId]);
    if (!user) throw Object.assign(new Error('Игрок не найден'), { status: 404 });
    if (user.role === 'admin') throw Object.assign(new Error('Нельзя изменить роль администратора'), { status: 400 });

    const nextRole = user.role === 'moderator' ? 'user' : 'moderator';
    const result = await run(`UPDATE users
      SET role = ?, is_approved = 1, dice_frozen = 0, pending_lucky_cell = NULL
      WHERE tg_id = ? AND COALESCE(role, 'user') <> 'admin'`, [nextRole, targetTgId]);
    if (result.changes === 0) throw Object.assign(new Error('Игрок не найден или роль нельзя изменить'), { status: 404 });

    res.json({ ok: true, user: await get('SELECT tg_id, username, role, is_approved FROM users WHERE tg_id = ?', [targetTgId]) });
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
    await requireModeratorOrAdmin(req.body.admin_tg_id);
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
    await addNewsEvent(`⚡️ Модератор одобрил работу ${formatUserHandle(userAfterApproval.username, userAfterApproval.tg_id)} на ${Number(submission.cell || 0)} клетке! Выдана Красочка №${issuedTickets[0].ticket_number}`, {
      eventType: 'admin_approve_submission',
      tgId: userAfterApproval.tg_id,
      ticketNumber: issuedTickets[0].ticket_number
    });
    await addApprovalNewsEvents(userAfterApproval, issuedTickets);

    res.json({ ok: true, issuedTickets, is_finalist: Number(userAfterApproval.current_cell) >= 100 });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reject-submission', async (req, res, next) => {
  try {
    await requireModeratorOrAdmin(req.body.admin_tg_id);
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
    const ticket = await issueTicket(tgId, 'bonus');
    await addNewsEvent(`🎁 Модератор вручную начислил бонусную Красочку №${ticket.ticket_number} игроку ${formatUserHandle(user.username, user.tg_id)}!`, {
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


async function collectDetailedPlayerExportRows() {
  const rows = await all(`SELECT u.tg_id, u.username, u.registered_at, u.last_login_at, u.current_cell, u.is_approved, u.dice_frozen, u.role,
      (SELECT COUNT(*) FROM submissions s WHERE s.tg_id = u.tg_id AND s.status = 'approved') AS completed_tasks,
      (SELECT COUNT(*) FROM tickets t WHERE t.tg_id = u.tg_id AND t.status = 'active') AS paint_balance,
      (SELECT COUNT(*) FROM submissions s WHERE s.tg_id = u.tg_id AND s.status = 'rejected') AS rejected_submissions
    FROM users u
    WHERE COALESCE(u.role, 'user') = 'user'
    ORDER BY u.username COLLATE NOCASE ASC, u.tg_id ASC`);

  const works = await all(`SELECT s.id, s.tg_id, s.task_id, s.cell, s.status, s.photo_before, s.photo_after, s.admin_comment, s.created_at, s.updated_at, t.text_task
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    ORDER BY s.tg_id ASC, s.created_at ASC, s.id ASC`);

  const worksByPlayer = new Map();
  for (const work of works) {
    if (!worksByPlayer.has(work.tg_id)) worksByPlayer.set(work.tg_id, []);
    worksByPlayer.get(work.tg_id).push({
      submission_id: work.id,
      task_id: work.task_id,
      cell: work.cell,
      status: work.status,
      task: work.text_task,
      photo_before_url: work.photo_before ? `/uploads/${work.photo_before}` : '',
      photo_after_url: work.photo_after ? `/uploads/${work.photo_after}` : '',
      admin_comment: work.admin_comment || '',
      created_at: work.created_at,
      updated_at: work.updated_at
    });
  }

  return rows.map((row) => ({
    telegram_id: row.tg_id,
    name: row.username || '',
    username: row.username || '',
    registered_at: row.registered_at || '',
    completed_tasks: Number(row.completed_tasks || 0),
    paint_balance: Number(row.paint_balance || 0),
    player_status: Number(row.is_approved) === 1 ? (Number(row.dice_frozen) === 1 ? 'Ждет проверку' : 'Активен') : 'Ожидает/исключен',
    rejected_submissions: Number(row.rejected_submissions || 0),
    last_login_at: row.last_login_at || '',
    works: worksByPlayer.get(row.tg_id) || []
  }));
}

app.get('/api/admin/game-stats-export', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const rows = await collectDetailedPlayerExportRows();
    const headers = ['Telegram ID', 'Имя', 'Username', 'Дата регистрации', 'Количество выполненных заданий', 'Текущий баланс красочек', 'Текущий статус игрока', 'Количество отклоненных заявок', 'Последний вход', 'История работ JSON'];
    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escapeCsv).join(';')];
    for (const row of rows) {
      lines.push([
        row.telegram_id,
        row.name,
        row.username,
        row.registered_at,
        row.completed_tasks,
        row.paint_balance,
        row.player_status,
        row.rejected_submissions,
        row.last_login_at,
        JSON.stringify(row.works)
      ].map(escapeCsv).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="krasochki-detailed-player-export.csv"');
    res.send(`\ufeff${lines.join('\n')}`);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/draw-winner', async (_req, res) => {
  res.status(410).json({ error: 'Ручной выбор победителя администратором отключен. Используйте Красочки игроков.' });
});

app.post('/api/admin/reset-round', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('DELETE FROM tickets');
    await run('DELETE FROM raffle_results');
    await run('DELETE FROM reaction_logs');
    await run('DELETE FROM puzzle_duels');
    await run('DELETE FROM news_events');
    await regenerateMapConfig();
    await loadMapConfig();
    await run(`UPDATE users
      SET current_cell = 0, dice_frozen = 0, pending_lucky_cell = NULL,
        has_used_tarot = 0, trap_immunity = 0, next_roll_halved = 0,
        penalty_rerolls = 0, total_dice_rolls = 0,
        reactions_hearts = 0, reactions_coffee = 0, can_challenge = 1, can_accept = 1`);
    await run('DELETE FROM sqlite_sequence WHERE name IN (?, ?, ?, ?, ?)', ['submissions', 'tickets', 'raffle_results', 'news_events', 'puzzle_duels']);
    res.json({ ok: true, trap_cells: [...TRAP_CELLS], lucky_cells: [...LUCKY_CELLS] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/global-reset', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('DELETE FROM raffle_results');
    await run('DELETE FROM tickets');
    await run('DELETE FROM news_events');
    await run('DELETE FROM reaction_logs');
    await run('DELETE FROM puzzle_duels');
    await run('DELETE FROM users WHERE tg_id <> ?', [OWNER_TG_ID]);
    await run('DELETE FROM sqlite_sequence WHERE name IN (?, ?, ?, ?, ?)', ['submissions', 'tickets', 'raffle_results', 'news_events', 'puzzle_duels']);
    await run(`UPDATE raffle_config
      SET raffle_start = '', raffle_end = '', total_prizes = 0, remaining_prizes = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`);
    await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role)
      VALUES (?, 'Owner', 0, 1, 0, 'admin')
      ON CONFLICT(tg_id) DO UPDATE SET
        current_cell = 0,
        dice_frozen = 0,
        pending_lucky_cell = NULL,
        has_used_tarot = 0,
        trap_immunity = 0,
        next_roll_halved = 0,
        penalty_rerolls = 0,
        total_dice_rolls = 0,
        can_challenge = 1,
        can_accept = 1,
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
