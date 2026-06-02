import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer() {
  const tempDir = await mkdtemp(join(tmpdir(), 'coloring-battle-'));
  const port = 3300 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEV_AUTH: '1',
      ADMIN_TG_IDS: '100',
      DB_PATH: join(tempDir, 'game.sqlite'),
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Error')) reject(new Error(text));
    });
    child.on('exit', (code) => reject(new Error(`server exited with code ${code}`)));
  });

  return {
    baseUrl: `http://localhost:${port}`,
    async close() {
      child.kill('SIGINT');
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

test('player approval, roll, submit and admin approval flow', async () => {
  const server = await startServer();
  try {
    const pendingPlayer = await request(server.baseUrl, '/api/me?tg_id=200&username=player');
    assert.equal(pendingPlayer.user.status, 'pending');

    const pendingUsers = await request(server.baseUrl, '/api/admin/pending-users?tg_id=100&username=admin');
    assert.equal(pendingUsers.users.length, 1);

    await request(server.baseUrl, `/api/admin/users/${pendingUsers.users[0].id}/approve?tg_id=100&username=admin`, { method: 'POST' });

    const roll = await request(server.baseUrl, '/api/roll?tg_id=200&username=player', { method: 'POST' });
    assert.equal(roll.dice >= 1 && roll.dice <= 6, true);
    assert.ok(roll.task.history_id);

    await request(server.baseUrl, '/api/submit?tg_id=200&username=player', {
      method: 'POST',
      body: JSON.stringify({ submission: 'https://example.com/photo.jpg' })
    });

    const submissions = await request(server.baseUrl, '/api/admin/submissions?tg_id=100&username=admin');
    assert.equal(submissions.submissions.length, 1);

    await request(server.baseUrl, `/api/admin/tasks/${roll.task.history_id}/approve?tg_id=100&username=admin`, { method: 'POST' });

    const finalState = await request(server.baseUrl, '/api/me?tg_id=200&username=player');
    assert.equal(finalState.user.completed_tasks, 1);
    assert.equal(finalState.activeTask, null);
  } finally {
    await server.close();
  }
});
