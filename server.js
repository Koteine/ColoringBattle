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
    role TEXT DEFAULT 'user'
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_task TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    cell INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    image_name TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    admin_comment TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tg_id) REFERENCES users(tg_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`);

  await ensureAccumulatingTicketsTable();

  await run('CREATE INDEX IF NOT EXISTS idx_submissions_player_status ON submissions(tg_id, status, task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_pending_images ON submissions(status, image_name)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_tg_id ON tickets(tg_id)');

  await run(`INSERT INTO users (tg_id, username, current_cell, is_approved, dice_frozen, role)
    VALUES (?, 'Owner', 0, 1, 0, 'admin')
    ON CONFLICT(tg_id) DO UPDATE SET
      username = CASE WHEN users.username = '' THEN 'Owner' ELSE users.username END,
      is_approved = 1,
      role = 'admin'`, [OWNER_TG_ID]);

  const taskCount = await get('SELECT COUNT(*) AS count FROM tasks');
  if (taskCount.count === 0) await seedTasks();
}

async function ensureAccumulatingTicketsTable() {
  const existing = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'");
  const desiredSql = `CREATE TABLE tickets (
    ticket_number INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    type TEXT DEFAULT 'standard' CHECK(type IN ('standard', 'bonus')),
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
  if (hasProperPrimaryKey && !hasTgIdUniqueness) return;

  await run('ALTER TABLE tickets RENAME TO tickets_old');
  await run(desiredSql);
  await run(`INSERT INTO tickets (ticket_number, tg_id, type, created_at)
    SELECT ticket_number, tg_id, COALESCE(type, 'standard'), COALESCE(created_at, CURRENT_TIMESTAMP)
    FROM tickets_old
    WHERE tg_id IS NOT NULL
    ORDER BY ticket_number ASC`);
  await run('DROP TABLE tickets_old');
}

async function seedTasks() {
  const baseTasks = [
    'Сфотографируйте предмет красного цвета.',
    'Нарисуйте радугу из пяти цветов и загрузите фото.',
    'Сфотографируйте круглый предмет рядом с вами.',
    'Сделайте фото предмета, который начинается на букву К.',
    'Найдите и сфотографируйте что-то синее.',
    'Сделайте фото своей чашки или бутылки воды.',
    'Сфотографируйте тень любого предмета.',
    'Нарисуйте смайлик и загрузите фото.',
    'Сделайте мини-коллаж из трех ярких цветов.',
    'Сфотографируйте предмет с цифрой.',
    'Покажите на фото что-то мягкое.',
    'Сфотографируйте рабочее место или творческий уголок.',
    'Нарисуйте флаг своей команды.',
    'Сделайте фото любого зеленого предмета.',
    'Сфотографируйте вещь необычной формы.',
    'Нарисуйте домик и загрузите фото.',
    'Сделайте фото предмета, который помещается в ладони.',
    'Сфотографируйте что-то блестящее.',
    'Нарисуйте маршрут из трех стрелок.',
    'Сделайте фото своего любимого цвета.'
  ];

  for (let lap = 1; lap <= 6; lap += 1) {
    for (const task of baseTasks) await run('INSERT INTO tasks (text_task) VALUES (?)', [`${task} Раунд ${lap}`]);
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

async function getActiveSubmission(tgId) {
  return get(`SELECT s.*, t.text_task
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.tg_id = ? AND s.status IN ('pending', 'rejected')
    ORDER BY s.id DESC
    LIMIT 1`, [tgId]);
}

async function getPlayerTickets(tgId) {
  return all('SELECT ticket_number, type, created_at FROM tickets WHERE tg_id = ? ORDER BY ticket_number ASC', [tgId]);
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
  const result = await run('INSERT INTO tickets (tg_id, type) VALUES (?, ?)', [tgId, type]);
  return get('SELECT ticket_number, type FROM tickets WHERE ticket_number = ?', [result.id]);
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
    res.json({ user, activeSubmission, tickets, needs_application: false, is_finalist: Number(user.current_cell) >= 100, is_admin: user.role === 'admin' });
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
    const [stats, finalists] = await Promise.all([
      get('SELECT COUNT(*) AS total_tickets FROM tickets'),
      all(`SELECT u.tg_id, u.username, u.current_cell, COUNT(t.ticket_number) AS tickets_count
        FROM users u
        LEFT JOIN tickets t ON t.tg_id = u.tg_id
        WHERE u.is_approved = 1 AND u.current_cell >= 100
        GROUP BY u.tg_id
        ORDER BY u.current_cell DESC, u.username COLLATE NOCASE ASC, u.tg_id ASC`)
    ]);
    res.json({ total_tickets: stats.total_tickets || 0, finalists });
  } catch (error) {
    next(error);
  }
});

app.post('/api/roll', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    if (Number(user.dice_frozen) === 1) throw Object.assign(new Error('Кубик заморожен до проверки задания'), { status: 400 });
    if (Number(user.current_cell) >= 100) throw Object.assign(new Error('Вы уже дошли до финиша'), { status: 400 });

    const task = await pickUnusedTask(tgId);
    if (!task) throw Object.assign(new Error('В базе нет заданий'), { status: 500 });

    const dice = rollD6();
    const currentCell = Math.min(100, Number(user.current_cell || 0) + dice);
    const submission = await run('INSERT INTO submissions (tg_id, cell, task_id, status) VALUES (?, ?, ?, ?)', [tgId, currentCell, task.id, 'pending']);
    await run('UPDATE users SET current_cell = ?, dice_frozen = 1 WHERE tg_id = ?', [currentCell, tgId]);

    res.json({ ok: true, dice, current_cell: currentCell, task, submission_id: submission.id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/submit', upload.single('work_image'), async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    await requireApproved(tgId);
    if (!req.file) throw Object.assign(new Error('Загрузите фото выполненной работы'), { status: 400 });

    const active = await getActiveSubmission(tgId);
    if (!active) throw Object.assign(new Error('Сначала бросьте кубик и получите задание'), { status: 400 });
    if (active.status === 'pending' && active.image_name) throw Object.assign(new Error('Работа уже ожидает проверки'), { status: 400 });

    await run(`UPDATE submissions
      SET image_name = ?, status = 'pending', admin_comment = '', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`, [req.file.filename, active.id]);

    const submission = await getActiveSubmission(tgId);
    res.json({ ok: true, image_name: req.file.filename, submission });
  } catch (error) {
    if (req.file) await fs.promises.rm(path.join(UPLOADS_DIR, req.file.filename), { force: true }).catch(() => {});
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
    const result = await run('UPDATE users SET is_approved = 1, current_cell = 0, dice_frozen = 0 WHERE tg_id = ?', [tgId]);
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
    const result = await run('UPDATE users SET is_approved = 0, dice_frozen = 0 WHERE tg_id = ?', [tgId]);
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
    const result = await run('UPDATE users SET current_cell = ? WHERE tg_id = ?', [currentCell, tgId]);
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
    const result = await run('UPDATE users SET dice_frozen = 0 WHERE tg_id = ?', [tgId]);
    if (result.changes === 0) throw Object.assign(new Error('Игрок не найден'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const submissions = await all(`SELECT s.id, s.tg_id, s.cell, s.task_id, s.image_name, s.status, s.admin_comment,
        u.username, t.text_task
      FROM submissions s
      JOIN users u ON u.tg_id = s.tg_id
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending' AND s.image_name IS NOT NULL
      ORDER BY s.updated_at ASC, s.id ASC`);
    res.json({ submissions });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/approve-submission', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const submissionId = Number(req.body.submission_id);
    if (!Number.isInteger(submissionId)) throw Object.assign(new Error('Некорректный ID работы'), { status: 400 });

    const submission = await get(`SELECT s.id, s.tg_id, s.cell, u.current_cell
      FROM submissions s
      JOIN users u ON u.tg_id = s.tg_id
      WHERE s.id = ? AND s.status = 'pending' AND s.image_name IS NOT NULL`, [submissionId]);
    if (!submission) throw Object.assign(new Error('Работа не найдена или уже проверена'), { status: 404 });

    await run("UPDATE submissions SET status = 'approved', admin_comment = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [submissionId]);
    await run('UPDATE users SET dice_frozen = 0 WHERE tg_id = ?', [submission.tg_id]);

    const issuedTickets = [await issueTicket(submission.tg_id, 'standard')];
    const userAfterApproval = await get('SELECT current_cell FROM users WHERE tg_id = ?', [submission.tg_id]);
    if (Number(userAfterApproval.current_cell) >= 100) {
      issuedTickets.push(await issueTicket(submission.tg_id, 'bonus'));
      issuedTickets.push(await issueTicket(submission.tg_id, 'bonus'));
    }

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
      WHERE id = ? AND status = 'pending' AND image_name IS NOT NULL`, [comment, submissionId]);
    if (result.changes === 0) throw Object.assign(new Error('Работа не найдена или уже проверена'), { status: 404 });
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

app.post('/api/admin/global-reset', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('DELETE FROM tickets');
    await run('DELETE FROM sqlite_sequence WHERE name IN (?, ?)', ['submissions', 'tickets']);
    await run('UPDATE users SET current_cell = 0, dice_frozen = 0');

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
