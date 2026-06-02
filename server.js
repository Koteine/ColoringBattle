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
const DATA_DIR = '/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'game.db');
const OWNER_TG_ID = '391995937';
const ADMIN_TG_IDS = new Set([OWNER_TG_ID, ...(process.env.ADMIN_TG_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)]);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
const db = new sqlite3.Database(DB_PATH);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const tgId = String(req.body.tg_id || 'unknown').replace(/\D/g, '') || 'unknown';
    const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${tgId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Можно загружать только изображения'));
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
    role TEXT DEFAULT 'player',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`INSERT OR IGNORE INTO users (tg_id, username, is_approved, dice_frozen, role)
    VALUES (?, ?, 1, 0, 'admin')`, [OWNER_TG_ID, 'Owner']);

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

  await run('CREATE INDEX IF NOT EXISTS idx_submissions_tg_status ON submissions(tg_id, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_submissions_status_image ON submissions(status, image_name)');

  const row = await get('SELECT COUNT(*) AS count FROM tasks');
  if (row.count === 0) await seedTasks();
}

async function seedTasks() {
  const tasks = [
    'Сфотографируйте предмет красного цвета.',
    'Нарисуйте простую звезду и загрузите фото.',
    'Сфотографируйте круглый предмет рядом с вами.',
    'Сделайте фото предмета, который начинается на букву К.',
    'Найдите и сфотографируйте что-то синее.',
    'Сделайте фото своей чашки или бутылки воды.',
    'Сфотографируйте тень любого предмета.',
    'Нарисуйте смайлик и загрузите фото.',
    'Сделайте мини-коллаж из трех цветов.',
    'Сфотографируйте предмет с цифрой.',
    'Покажите на фото что-то мягкое.',
    'Сфотографируйте рабочее место или игровой уголок.',
    'Нарисуйте флаг своей команды.',
    'Сделайте фото любого зеленого предмета.',
    'Сфотографируйте вещь необычной формы.',
    'Нарисуйте домик и загрузите фото.',
    'Сделайте фото предмета, который помещается в ладони.',
    'Сфотографируйте что-то блестящее.',
    'Нарисуйте маршрут из трех стрелок.',
    'Сделайте фото своего любимого цвета.'
  ];

  for (let cycle = 0; cycle < 6; cycle += 1) {
    for (const task of tasks) await run('INSERT INTO tasks (text_task) VALUES (?)', [`${task} #${cycle + 1}`]);
  }
}

function normalizeTgId(value) {
  const tgId = String(value || '').trim();
  if (!tgId) throw new Error('Не передан Telegram ID');
  return tgId;
}

async function ensureUser(tgId, username = '') {
  const role = ADMIN_TG_IDS.has(String(tgId)) ? 'admin' : 'player';
  const approved = role === 'admin' ? 1 : 0;

  await run(`INSERT INTO users (tg_id, username, is_approved, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET
      username = CASE WHEN excluded.username != '' THEN excluded.username ELSE users.username END,
      role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE users.role END,
      is_approved = CASE WHEN excluded.role = 'admin' THEN 1 ELSE users.is_approved END`,
    [String(tgId), String(username || ''), approved, role]);

  return get('SELECT * FROM users WHERE tg_id = ?', [String(tgId)]);
}

async function requireApproved(tgId) {
  const user = await get('SELECT * FROM users WHERE tg_id = ?', [String(tgId)]);
  if (!user || user.is_approved !== 1) throw Object.assign(new Error('Пользователь еще не одобрен администратором'), { status: 403 });
  return user;
}

async function requireAdmin(tgId) {
  if (ADMIN_TG_IDS.has(String(tgId))) await ensureUser(tgId);
  const user = await requireApproved(tgId);
  if (user.role !== 'admin') throw Object.assign(new Error('Доступ только для администратора'), { status: 403 });
  return user;
}

async function pickTask(tgId) {
  const fresh = await get(`SELECT id, text_task FROM tasks
    WHERE id NOT IN (
      SELECT task_id FROM submissions
      WHERE tg_id = ? AND status IN ('approved', 'pending')
    )
    ORDER BY RANDOM()
    LIMIT 1`, [String(tgId)]);

  if (fresh) return fresh;
  return get('SELECT id, text_task FROM tasks ORDER BY RANDOM() LIMIT 1');
}

app.get('/api/me/:tg_id', async (req, res, next) => {
  try {
    const user = await ensureUser(normalizeTgId(req.params.tg_id), req.query.username);
    const activeSubmission = await get(`SELECT s.*, t.text_task FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.tg_id = ? AND s.status IN ('pending', 'rejected')
      ORDER BY s.id DESC LIMIT 1`, [user.tg_id]);
    res.json({ user, activeSubmission });
  } catch (error) {
    next(error);
  }
});

app.post('/api/roll', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    const user = await requireApproved(tgId);
    if (user.dice_frozen === 1) throw Object.assign(new Error('Кубик заморожен до проверки задания'), { status: 409 });

    const dice = crypto.randomInt(1, 7);
    const newCell = Math.min(100, Number(user.current_cell || 0) + dice);
    const task = await pickTask(tgId);
    if (!task) throw Object.assign(new Error('В базе нет заданий'), { status: 500 });

    await run('UPDATE users SET current_cell = ?, dice_frozen = 1 WHERE tg_id = ?', [newCell, tgId]);
    const submission = await run('INSERT INTO submissions (tg_id, cell, task_id, status) VALUES (?, ?, ?, ?)', [tgId, newCell, task.id, 'pending']);

    res.json({ dice, current_cell: newCell, task, submission_id: submission.id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/submit', upload.single('work_image'), async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.body.tg_id);
    await requireApproved(tgId);
    if (!req.file) throw Object.assign(new Error('Загрузите изображение выполненной работы'), { status: 400 });

    const current = await get(`SELECT id FROM submissions
      WHERE tg_id = ? AND status IN ('pending', 'rejected')
      ORDER BY id DESC LIMIT 1`, [tgId]);
    if (!current) throw Object.assign(new Error('Нет активного задания для сдачи'), { status: 409 });

    await run(`UPDATE submissions
      SET image_name = ?, status = 'pending', admin_comment = '', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`, [req.file.filename, current.id]);

    res.json({ ok: true, image_name: req.file.filename, image_url: `/uploads/${req.file.filename}` });
  } catch (error) {
    next(error);
  }
});

app.get('/api/check-status/:tg_id', async (req, res, next) => {
  try {
    const tgId = normalizeTgId(req.params.tg_id);
    const user = await get('SELECT tg_id, dice_frozen FROM users WHERE tg_id = ?', [tgId]);
    const latest = await get(`SELECT s.*, t.text_task FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.tg_id = ?
      ORDER BY s.id DESC LIMIT 1`, [tgId]);
    res.json({ dice_frozen: user?.dice_frozen ?? 0, submission: latest || null });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/pending-users', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const users = await all(`SELECT tg_id, username, created_at FROM users
      WHERE is_approved = 0
      ORDER BY created_at ASC`);
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/approve-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    await run('UPDATE users SET is_approved = 1 WHERE tg_id = ?', [tgId]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', async (req, res, next) => {
  try {
    await requireAdmin(req.query.admin_tg_id);
    const users = await all(`SELECT tg_id, username, current_cell, is_approved, dice_frozen, role, created_at FROM users
      ORDER BY role DESC, is_approved DESC, username COLLATE NOCASE ASC, tg_id ASC`);
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/add-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    await run(`INSERT INTO users (tg_id, username, is_approved, dice_frozen, role)
      VALUES (?, ?, 1, 0, 'player')
      ON CONFLICT(tg_id) DO UPDATE SET is_approved = 1`, [tgId, req.body.username ? String(req.body.username).trim() : '']);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/remove-user', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const tgId = normalizeTgId(req.body.tg_id);
    if (tgId === OWNER_TG_ID) throw Object.assign(new Error('Нельзя исключить супер-админа'), { status: 400 });
    await run('UPDATE users SET is_approved = 0, dice_frozen = 0 WHERE tg_id = ?', [tgId]);
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
    if (!Number.isInteger(currentCell) || currentCell < 0 || currentCell > 100) throw Object.assign(new Error('Клетка должна быть целым числом от 0 до 100'), { status: 400 });
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
    const submissions = await all(`SELECT s.id, s.tg_id, s.cell, s.image_name, s.status, s.admin_comment,
        u.username, t.text_task
      FROM submissions s
      JOIN users u ON u.tg_id = s.tg_id
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending' AND s.image_name IS NOT NULL
      ORDER BY s.updated_at ASC`);
    res.json({ submissions });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/approve-submission', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const submissionId = Number(req.body.submission_id);
    const submission = await get('SELECT tg_id FROM submissions WHERE id = ? AND status = ?', [submissionId, 'pending']);
    if (!submission) throw Object.assign(new Error('Сдача не найдена или уже проверена'), { status: 404 });

    await run("UPDATE submissions SET status = 'approved', admin_comment = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [submissionId]);
    await run('UPDATE users SET dice_frozen = 0 WHERE tg_id = ?', [submission.tg_id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reject-submission', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    const submissionId = Number(req.body.submission_id);
    const comment = String(req.body.admin_comment || '').trim();
    if (!comment) throw Object.assign(new Error('Добавьте комментарий для отклонения'), { status: 400 });

    const result = await run("UPDATE submissions SET status = 'rejected', admin_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [comment, submissionId]);
    if (result.changes === 0) throw Object.assign(new Error('Сдача не найдена или уже проверена'), { status: 404 });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/global-reset', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('UPDATE users SET current_cell = 0, dice_frozen = 0');
    for (const fileName of await fs.promises.readdir(UPLOADS_DIR)) {
      await fs.promises.rm(path.join(UPLOADS_DIR, fileName), { force: true, recursive: true });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reset', async (req, res, next) => {
  try {
    await requireAdmin(req.body.admin_tg_id);
    await run('DELETE FROM submissions');
    await run('UPDATE users SET current_cell = 0, dice_frozen = 0');
    for (const fileName of await fs.promises.readdir(UPLOADS_DIR)) {
      await fs.promises.rm(path.join(UPLOADS_DIR, fileName), { force: true, recursive: true });
    }
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

initDb().then(() => {
  app.listen(PORT, () => console.log(`Coloring Battle server started on port ${PORT}`));
}).catch((error) => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});
