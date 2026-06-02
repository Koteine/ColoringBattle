import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = resolve(process.env.DB_PATH || join(__dirname, 'game.sqlite'));
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV_AUTH = process.env.DEV_AUTH === '1' || process.env.NODE_ENV === 'development';
const ADMIN_TG_IDS = new Set((process.env.ADMIN_TG_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));

if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL UNIQUE,
      username TEXT DEFAULT '',
      current_cell INTEGER NOT NULL DEFAULT 0 CHECK (current_cell BETWEEN 0 AND 100),
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'banned')),
      role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5)
    );

    CREATE TABLE IF NOT EXISTS user_tasks_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      cell INTEGER NOT NULL CHECK (cell BETWEEN 0 AND 100),
      dice INTEGER NOT NULL CHECK (dice BETWEEN 1 AND 6),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      submission TEXT DEFAULT '',
      admin_comment TEXT DEFAULT '',
      submitted_at TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id);
    CREATE INDEX IF NOT EXISTS idx_history_user_status ON user_tasks_history(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_history_submitted ON user_tasks_history(status, submitted_at);
  `);

  const count = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  if (count === 0) seedTasks();
}

function runTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedTasks() {
  const sampleTasks = [
    'Сделайте фото предмета вокруг себя, в котором есть красный цвет.',
    'Нарисуйте простую звезду и отправьте фото.',
    'Напишите 3 добрых слова другому игроку.',
    'Сделайте фото своей чашки или бутылки воды.',
    'Найдите вокруг себя круглый предмет и пришлите фото.',
    'Напишите короткий девиз своей команды.',
    'Сделайте мини-коллаж из 3 цветов и отправьте ссылку/фото.',
    'Сфотографируйте что-то синее.',
    'Придумайте название для клетки, на которой стоите.',
    'Напишите, какой суперсилой хотели бы обладать сегодня.',
    'Сделайте фото предмета, который начинается на букву К.',
    'Нарисуйте смайлик и отправьте подтверждение.',
    'Напишите 5 слов, связанных с летом.',
    'Сфотографируйте тень любого предмета.',
    'Опишите свой день одним предложением.',
    'Сделайте фото чего-то мягкого.',
    'Найдите предмет с цифрой и отправьте фото.',
    'Придумайте смешное правило для игры.',
    'Напишите короткое пожелание всем участникам.',
    'Сделайте фото своего рабочего места или игрового уголка.'
  ];
  const insert = db.prepare('INSERT INTO tasks (text, difficulty) VALUES (?, ?)');
  runTransaction(() => {
    for (let i = 0; i < 120; i += 1) insert.run(`${sampleTasks[i % sampleTasks.length]} #${i + 1}`, (i % 5) + 1);
  });
}

initDatabase();

function sendJson(res, status, payload) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error('Payload is too large'));
    });
    req.on('end', () => {
      if (!raw) return resolveBody({});
      try { resolveBody(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
  });
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required for Telegram auth');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing Telegram hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(hash))) throw new Error('Invalid Telegram hash');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Telegram user is missing');
  return { tg_id: String(user.id), username: user.username || user.first_name || `user_${user.id}` };
}

function getAuthIdentity(req, url) {
  const initData = req.headers['x-telegram-init-data'];
  if (initData) return verifyTelegramInitData(initData);
  if (DEV_AUTH && url.searchParams.get('tg_id')) {
    return { tg_id: String(url.searchParams.get('tg_id')), username: url.searchParams.get('username') || `dev_${url.searchParams.get('tg_id')}` };
  }
  throw new Error('Telegram authorization data is missing');
}

function upsertAndGetUser(identity) {
  const isAdmin = ADMIN_TG_IDS.has(identity.tg_id);
  db.prepare(`
    INSERT INTO users (tg_id, username, status, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username, updated_at = CURRENT_TIMESTAMP
  `).run(identity.tg_id, identity.username, isAdmin ? 'active' : 'pending', isAdmin ? 'admin' : 'player');
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(identity.tg_id);
}

function requireActive(user) {
  if (user.status === 'banned') throw Object.assign(new Error('Пользователь заблокирован'), { status: 403 });
  if (user.status !== 'active') throw Object.assign(new Error('Доступ еще не одобрен администратором'), { status: 403 });
}

function requireAdmin(user) {
  requireActive(user);
  if (user.role !== 'admin') throw Object.assign(new Error('Нужны права администратора'), { status: 403 });
}

function buildPlayerState(user) {
  const activeTask = db.prepare(`
    SELECT h.id AS history_id, h.cell, h.dice, h.status, h.submission, h.submitted_at, h.admin_comment,
           t.id AS task_id, t.text, t.difficulty
    FROM user_tasks_history h
    JOIN tasks t ON t.id = h.task_id
    WHERE h.user_id = ? AND h.status IN ('pending', 'rejected')
      AND NOT EXISTS (
        SELECT 1 FROM user_tasks_history newer
        WHERE newer.user_id = h.user_id AND newer.id > h.id
      )
    ORDER BY h.id DESC LIMIT 1
  `).get(user.id) || null;
  return { user, activeTask };
}

function chooseTaskForUser(userId) {
  const tasks = db.prepare(`
    SELECT id, text, difficulty FROM tasks
    WHERE id NOT IN (SELECT task_id FROM user_tasks_history WHERE user_id = ?)
    ORDER BY random() LIMIT 1
  `).get(userId);
  if (!tasks) throw Object.assign(new Error('Пул заданий для игрока исчерпан'), { status: 409 });
  return tasks;
}

async function handleApi(req, res, url) {
  const identity = getAuthIdentity(req, url);
  const user = upsertAndGetUser(identity);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/me') return sendJson(res, 200, buildPlayerState(user));

  requireActive(user);

  if (req.method === 'POST' && path === '/api/roll') {
    const pending = db.prepare("SELECT id FROM user_tasks_history WHERE user_id = ? AND status IN ('pending', 'rejected') LIMIT 1").get(user.id);
    if (pending) throw Object.assign(new Error('Кубик заблокирован: сначала сдайте или дождитесь проверки задания'), { status: 409 });
    const dice = crypto.randomInt(1, 7);
    const nextCell = Math.min(100, user.current_cell + dice);
    const task = chooseTaskForUser(user.id);
    const historyId = runTransaction(() => {
      db.prepare('UPDATE users SET current_cell = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextCell, user.id);
      const result = db.prepare('INSERT INTO user_tasks_history (user_id, task_id, cell, dice) VALUES (?, ?, ?, ?)').run(user.id, task.id, nextCell, dice);
      return result.lastInsertRowid;
    });
    return sendJson(res, 200, { dice, current_cell: nextCell, task: { history_id: historyId, ...task } });
  }

  if (req.method === 'POST' && path === '/api/submit') {
    const body = await parseBody(req);
    const submission = String(body.submission || '').trim();
    if (submission.length < 3) throw Object.assign(new Error('Добавьте ссылку на фото или текстовое подтверждение'), { status: 400 });
    const active = db.prepare("SELECT id FROM user_tasks_history WHERE user_id = ? AND status IN ('pending', 'rejected') ORDER BY id DESC LIMIT 1").get(user.id);
    if (!active) throw Object.assign(new Error('Нет активного задания для сдачи'), { status: 409 });
    db.prepare("UPDATE user_tasks_history SET status = 'pending', submission = ?, admin_comment = '', submitted_at = CURRENT_TIMESTAMP WHERE id = ?").run(submission, active.id);
    return sendJson(res, 200, { ok: true });
  }

  if (path.startsWith('/api/admin/')) requireAdmin(user);

  if (req.method === 'GET' && path === '/api/admin/pending-users') {
    const users = db.prepare("SELECT id, tg_id, username, created_at FROM users WHERE status = 'pending' ORDER BY created_at ASC").all();
    return sendJson(res, 200, { users });
  }

  const approveUser = path.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
  if (req.method === 'POST' && approveUser) {
    db.prepare("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(approveUser[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/submissions') {
    const submissions = db.prepare(`
      SELECT h.id AS history_id, h.cell, h.dice, h.submission, h.submitted_at, u.username, u.tg_id, t.text AS task_text
      FROM user_tasks_history h
      JOIN users u ON u.id = h.user_id
      JOIN tasks t ON t.id = h.task_id
      WHERE h.status = 'pending' AND h.submitted_at IS NOT NULL
      ORDER BY h.submitted_at ASC
    `).all();
    return sendJson(res, 200, { submissions });
  }

  const approveTask = path.match(/^\/api\/admin\/tasks\/(\d+)\/approve$/);
  if (req.method === 'POST' && approveTask) {
    runTransaction(() => {
      const row = db.prepare("SELECT user_id FROM user_tasks_history WHERE id = ? AND status = 'pending' AND submitted_at IS NOT NULL").get(Number(approveTask[1]));
      if (!row) throw Object.assign(new Error('Задание не найдено или уже проверено'), { status: 404 });
      db.prepare("UPDATE user_tasks_history SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(approveTask[1]));
      db.prepare('UPDATE users SET completed_tasks = completed_tasks + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.user_id);
    });
    return sendJson(res, 200, { ok: true });
  }

  const rejectTask = path.match(/^\/api\/admin\/tasks\/(\d+)\/reject$/);
  if (req.method === 'POST' && rejectTask) {
    const body = await parseBody(req);
    const comment = String(body.comment || '').trim();
    if (!comment) throw Object.assign(new Error('Укажите комментарий для отклонения'), { status: 400 });
    db.prepare("UPDATE user_tasks_history SET status = 'rejected', admin_comment = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(comment, Number(rejectTask[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/admin/reset') {
    runTransaction(() => {
      db.prepare('DELETE FROM user_tasks_history').run();
      db.prepare('UPDATE users SET current_cell = 0, completed_tasks = 0, updated_at = CURRENT_TIMESTAMP').run();
    });
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Endpoint not found' });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = resolve(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    const data = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
    res.end(data);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || (error.message.includes('auth') || error.message.includes('Telegram') ? 401 : 500);
    sendJson(res, status, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Telegram board game is running on http://localhost:${PORT}`);
  if (!BOT_TOKEN && !DEV_AUTH) console.warn('BOT_TOKEN is not set. Set BOT_TOKEN for production Telegram WebApp auth.');
});
