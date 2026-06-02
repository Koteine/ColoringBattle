import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DATA_DB = '/data/game.db';
const DATA_UPLOADS = '/data/uploads';

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  await rm(DATA_DB, { force: true });
  await rm(DATA_UPLOADS, { recursive: true, force: true });

  const port = 3400 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ADMIN_TG_IDS: '100' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('started')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Database initialization failed')) reject(new Error(text));
    });
    child.on('exit', (code) => reject(new Error(`server exited with code ${code}`)));
  });

  return {
    baseUrl: `http://localhost:${port}`,
    async close() {
      child.kill('SIGINT');
      await wait(100);
    }
  };
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

test('approval, roll, image submit, polling status and admin approval flow', async () => {
  const server = await startServer();
  try {
    const pending = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(pending.user.is_approved, 0);

    const pendingUsers = await jsonRequest(server.baseUrl, '/api/admin/pending-users?admin_tg_id=100');
    assert.equal(pendingUsers.users.length, 1);

    await jsonRequest(server.baseUrl, '/api/admin/approve-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '100', tg_id: '200' })
    });

    const roll = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '200' })
    });
    assert.equal(roll.dice >= 1 && roll.dice <= 6, true);

    const imagePath = '/tmp/coloring-test.png';
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const form = new FormData();
    form.append('tg_id', '200');
    form.append('work_image', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'work.png');

    const submitResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: form });
    const submit = await submitResponse.json();
    assert.equal(submitResponse.ok, true);
    assert.equal(existsSync(`${DATA_UPLOADS}/${submit.image_name}`), true);

    const checkPending = await jsonRequest(server.baseUrl, '/api/check-status/200');
    assert.equal(checkPending.submission.status, 'pending');

    const feed = await jsonRequest(server.baseUrl, '/api/admin/submissions?admin_tg_id=100');
    assert.equal(feed.submissions.length, 1);

    await jsonRequest(server.baseUrl, '/api/admin/approve-submission', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '100', submission_id: feed.submissions[0].id })
    });

    const checkApproved = await jsonRequest(server.baseUrl, '/api/check-status/200');
    assert.equal(checkApproved.submission.status, 'approved');
    assert.equal(checkApproved.dice_frozen, 0);
  } finally {
    await server.close();
  }
});
