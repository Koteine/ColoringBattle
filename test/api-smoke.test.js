import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sqlite3 from 'sqlite3';

const DATA_DB = '/data/game.db';
const DATA_UPLOADS = '/data/uploads';

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer({ clean = true } = {}) {
  if (clean) {
    await rm(DATA_DB, { force: true });
    await rm(DATA_UPLOADS, { recursive: true, force: true });
  }

  const port = 3400 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
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


async function ensureRollCreatedSubmission(baseUrl, tgId, rollResult) {
  if (!rollResult.lucky_options) return rollResult;
  return jsonRequest(baseUrl, '/api/lucky-choice', {
    method: 'POST',
    body: JSON.stringify({ tg_id: tgId, choice: rollResult.lucky_options[0] })
  });
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

async function dbRun(sql, params = []) {
  const db = new sqlite3.Database(DATA_DB);
  try {
    await new Promise((resolve, reject) => {
      db.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

test('approval, roll, image submit, polling status and admin approval flow', async () => {
  const server = await startServer();
  try {
    const firstVisit = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(firstVisit.needs_application, true);
    assert.equal(firstVisit.user, null);

    const pending = await jsonRequest(server.baseUrl, '/api/apply', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '200', username: 'player' })
    });
    assert.equal(pending.user.is_approved, 0);

    const pendingUsers = await jsonRequest(server.baseUrl, '/api/admin/pending-users?admin_tg_id=341995937');
    assert.equal(pendingUsers.users.length, 1);

    await jsonRequest(server.baseUrl, '/api/admin/approve-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '200' })
    });

    const roll = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '200' })
    });
    assert.equal(roll.dice >= 1 && roll.dice <= 6, true);
    await ensureRollCreatedSubmission(server.baseUrl, '200', roll);

    const imagePath = '/tmp/coloring-test.png';
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const beforeForm = new FormData();
    beforeForm.append('tg_id', '200');
    beforeForm.append('photo_before', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'before.png');

    const beforeResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: beforeForm });
    const beforeSubmit = await beforeResponse.json();
    assert.equal(beforeResponse.ok, true);
    assert.equal(beforeSubmit.uploaded_stage, 'before');
    assert.equal(existsSync(`${DATA_UPLOADS}/${beforeSubmit.image_name}`), true);

    const feedBeforeAfter = await jsonRequest(server.baseUrl, '/api/admin/submissions?admin_tg_id=341995937');
    assert.equal(feedBeforeAfter.submissions.length, 0);

    const form = new FormData();
    form.append('tg_id', '200');
    form.append('photo_after', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'after.png');

    const submitResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: form });
    const submit = await submitResponse.json();
    assert.equal(submitResponse.ok, true);
    assert.equal(submit.uploaded_stage, 'after');
    assert.equal(existsSync(`${DATA_UPLOADS}/${submit.image_name}`), true);

    const checkPending = await jsonRequest(server.baseUrl, '/api/check-status/200');
    assert.equal(checkPending.submission.status, 'pending');

    const feed = await jsonRequest(server.baseUrl, '/api/admin/submissions?admin_tg_id=341995937');
    assert.equal(feed.submissions.length, 1);
    assert.ok(feed.submissions[0].photo_before);
    assert.ok(feed.submissions[0].photo_after);

    await jsonRequest(server.baseUrl, '/api/admin/approve-submission', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', submission_id: feed.submissions[0].id })
    });

    const checkApproved = await jsonRequest(server.baseUrl, '/api/check-status/200');
    assert.equal(checkApproved.submission.status, 'approved');
    assert.equal(checkApproved.dice_frozen, 0);
    assert.equal(checkApproved.tickets.length, 1);

    const paletteAfterApproval = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(Boolean(paletteAfterApproval.activeSubmission), false);
    assert.equal(paletteAfterApproval.user.dice_frozen, 0);
    assert.equal(paletteAfterApproval.tickets.length, 1);
    assert.equal(paletteAfterApproval.tickets[0].submission_status, 'approved');
    assert.ok(paletteAfterApproval.tickets[0].source);
    assert.equal(paletteAfterApproval.tickets[0].file_url, `/uploads/${paletteAfterApproval.tickets[0].source}`);
    assert.equal(paletteAfterApproval.tickets[0].image_url, paletteAfterApproval.tickets[0].file_url);

    await jsonRequest(server.baseUrl, '/api/admin/remove-ticket', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', ticket_number: paletteAfterApproval.tickets[0].ticket_number, admin_comment: 'тестовая причина' })
    });
    const paletteAfterRevoke = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(paletteAfterRevoke.tickets.length, 1);
    assert.equal(paletteAfterRevoke.tickets[0].status, 'revoked');
    assert.equal(paletteAfterRevoke.tickets[0].revoke_comment, 'тестовая причина');

    await dbRun(`INSERT INTO submissions (tg_id, cell, task_id, assigned_task_text, status, created_at, updated_at)
      VALUES ('200', 999, 1, 'Зависшее старое задание', 'pending', datetime('now', '-1 day'), datetime('now', '-1 day'))`);
    const fixedStaleTask = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(fixedStaleTask.user.dice_frozen, 1);
    assert.equal(fixedStaleTask.activeSubmission.text_task, 'Зависшее старое задание');
    await dbRun("DELETE FROM submissions WHERE tg_id = '200' AND cell = 999");
    await dbRun("UPDATE users SET dice_frozen = 0 WHERE tg_id = '200'");

    const workId = paletteAfterApproval.tickets[0].submission_id;
    const ownerWorkDetails = await jsonRequest(server.baseUrl, `/api/work-details/${workId}?viewer_tg_id=200`);
    assert.equal(ownerWorkDetails.work.is_owner, true);
    assert.ok(ownerWorkDetails.work.text_task);
    assert.ok(ownerWorkDetails.work.image_before);
    assert.ok(ownerWorkDetails.work.image_after);

    const adminWorkDetails = await jsonRequest(server.baseUrl, `/api/work-details/${workId}?viewer_tg_id=341995937`);
    assert.equal(adminWorkDetails.work.is_admin, true);
    assert.ok(adminWorkDetails.work.text_task);
    assert.ok(adminWorkDetails.work.image_before);

    await jsonRequest(server.baseUrl, '/api/apply', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '202', username: 'viewer' })
    });
    await jsonRequest(server.baseUrl, '/api/admin/approve-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '202' })
    });
    const publicWorkDetails = await jsonRequest(server.baseUrl, `/api/work-details/${workId}?viewer_tg_id=202`);
    assert.equal(publicWorkDetails.work.is_owner, false);
    assert.equal(publicWorkDetails.work.is_admin, false);
    assert.equal(publicWorkDetails.work.can_view_private, false);
    assert.ok(publicWorkDetails.work.image_after);
    assert.equal(publicWorkDetails.work.image_before, undefined);
    assert.equal(publicWorkDetails.work.text_task, undefined);

    const news = await jsonRequest(server.baseUrl, '/api/news');
    assert.match(news.events[0].message, /Красочка №1 досталась @player/);

    const secondRoll = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '200' })
    });
    await ensureRollCreatedSubmission(server.baseUrl, '200', secondRoll);

    const stateAfterSecondRoll = await jsonRequest(server.baseUrl, '/api/me/200?username=player');
    assert.equal(stateAfterSecondRoll.user.dice_frozen, 1);
    assert.equal(stateAfterSecondRoll.activeSubmission.status, 'pending');
    assert.equal(stateAfterSecondRoll.activeSubmission.photo_before, null);
    assert.equal(stateAfterSecondRoll.activeSubmission.photo_after, null);

    const prematureSecondAfterForm = new FormData();
    prematureSecondAfterForm.append('tg_id', '200');
    prematureSecondAfterForm.append('photo_after', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'premature-after-2.png');
    const prematureSecondAfterResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: prematureSecondAfterForm });
    assert.equal(prematureSecondAfterResponse.ok, false);
    const prematureSecondAfter = await prematureSecondAfterResponse.json();
    assert.match(prematureSecondAfter.error, /Сначала загрузите фото ДО/);

    const secondBeforeForm = new FormData();
    secondBeforeForm.append('tg_id', '200');
    secondBeforeForm.append('photo_before', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'before-2.png');
    const secondBeforeSubmitResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: secondBeforeForm });
    assert.equal(secondBeforeSubmitResponse.ok, true);

    const secondForm = new FormData();
    secondForm.append('tg_id', '200');
    secondForm.append('photo_after', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'after-2.png');
    const secondSubmitResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: secondForm });
    assert.equal(secondSubmitResponse.ok, true);

    const secondFeed = await jsonRequest(server.baseUrl, '/api/admin/submissions?admin_tg_id=341995937');
    await jsonRequest(server.baseUrl, '/api/admin/approve-submission', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', submission_id: secondFeed.submissions[0].id })
    });

    const checkAccumulated = await jsonRequest(server.baseUrl, '/api/check-status/200');
    assert.equal(checkAccumulated.tickets.length, 2);

    const now = Date.now();
    const config = await jsonRequest(server.baseUrl, '/api/admin/raffle-config', {
      method: 'POST',
      body: JSON.stringify({
        admin_tg_id: '341995937',
        raffle_start: new Date(now - 60_000).toISOString(),
        raffle_end: new Date(now + 3_600_000).toISOString(),
        total_prizes: 2
      })
    });
    assert.equal(config.ok, true);
    assert.equal(config.is_active, true);
    assert.equal(config.remaining_prizes, 2);

    const scratch = await jsonRequest(server.baseUrl, '/api/raffle/scratch-ticket', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '200', ticket_number: checkAccumulated.tickets[1].ticket_number })
    });
    assert.equal(scratch.ok, true);
    assert.equal(scratch.result, 'win');
    assert.equal(scratch.winner.tg_id, '200');
    assert.equal(scratch.remaining_prizes, 1);

    const drawResponse = await fetch(`${server.baseUrl}/api/admin/draw-winner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_tg_id: '341995937' })
    });
    assert.equal(drawResponse.status, 410);

    const grant = await jsonRequest(server.baseUrl, '/api/admin/grant-ticket', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '200' })
    });
    assert.equal(grant.ticket.ticket_number, 3);
    assert.equal(grant.ticket.status, 'active');
    assert.equal(grant.ticket.type, 'bonus');

    const registry = await jsonRequest(server.baseUrl, '/api/admin/tickets?admin_tg_id=341995937');
    assert.equal(registry.tickets.length, 3);

    await jsonRequest(server.baseUrl, '/api/admin/remove-ticket', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', ticket_number: grant.ticket.ticket_number, admin_comment: 'ручная корректировка' })
    });

    const registryAfterRemoval = await jsonRequest(server.baseUrl, '/api/admin/tickets?admin_tg_id=341995937');
    assert.equal(registryAfterRemoval.tickets.length, 3);
    const revokedTicket = registryAfterRemoval.tickets.find((ticket) => ticket.ticket_number === grant.ticket.ticket_number);
    assert.equal(revokedTicket.status, 'revoked');
    assert.equal(revokedTicket.revoke_comment, 'ручная корректировка');

    await jsonRequest(server.baseUrl, '/api/apply', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '201', username: 'managed' })
    });
    await jsonRequest(server.baseUrl, '/api/admin/approve-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '201' })
    });

    const moved = await jsonRequest(server.baseUrl, '/api/admin/change-cell', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '201', current_cell: 42 })
    });
    assert.equal(moved.current_cell, 42);

    const managedRoll = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '201' })
    });
    await ensureRollCreatedSubmission(server.baseUrl, '201', managedRoll);

    const unfrozen = await jsonRequest(server.baseUrl, '/api/admin/reset-dice', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '201' })
    });
    assert.equal(unfrozen.ok, true);
    const rollAfterAdminReset = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '201' })
    });
    assert.equal(rollAfterAdminReset.dice >= 1 && rollAfterAdminReset.dice <= 6, true);

    const moderator = await jsonRequest(server.baseUrl, '/api/admin/toggle-moderator', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', target_tg_id: '201' })
    });
    assert.equal(moderator.user.role, 'moderator');

    const removedUser = await jsonRequest(server.baseUrl, '/api/admin/remove-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '201' })
    });
    assert.equal(removedUser.ok, true);
  } finally {
    await server.close();
  }
});


test('active assignment survives server restart and still accepts before/after photos', async () => {
  let server = await startServer();
  const imagePath = '/tmp/coloring-restart-test.png';
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));

  try {
    await jsonRequest(server.baseUrl, '/api/apply', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '300', username: 'restart_player' })
    });
    await jsonRequest(server.baseUrl, '/api/admin/approve-user', {
      method: 'POST',
      body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '300' })
    });
    const roll = await jsonRequest(server.baseUrl, '/api/roll', {
      method: 'POST',
      body: JSON.stringify({ tg_id: '300' })
    });
    await ensureRollCreatedSubmission(server.baseUrl, '300', roll);

    const beforeRestart = await jsonRequest(server.baseUrl, '/api/me/300?username=restart_player');
    assert.ok(beforeRestart.activeSubmission?.text_task);
    assert.equal(beforeRestart.user.dice_frozen, 1);
  } finally {
    await server.close();
  }

  server = await startServer({ clean: false });
  try {
    const afterRestart = await jsonRequest(server.baseUrl, '/api/me/300?username=restart_player');
    assert.ok(afterRestart.activeSubmission?.text_task);
    assert.equal(afterRestart.user.dice_frozen, 1);

    const beforeForm = new FormData();
    beforeForm.append('tg_id', '300');
    beforeForm.append('photo_before', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'before.png');
    const beforeResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: beforeForm });
    const beforeSubmit = await beforeResponse.json();
    assert.equal(beforeResponse.ok, true);
    assert.equal(beforeSubmit.uploaded_stage, 'before');

    const afterForm = new FormData();
    afterForm.append('tg_id', '300');
    afterForm.append('photo_after', new Blob([await readFile(imagePath)], { type: 'image/png' }), 'after.png');
    const afterResponse = await fetch(`${server.baseUrl}/api/submit`, { method: 'POST', body: afterForm });
    const afterSubmit = await afterResponse.json();
    assert.equal(afterResponse.ok, true);
    assert.equal(afterSubmit.uploaded_stage, 'after');
  } finally {
    await server.close();
  }
});

test('Rapunzel buff doubles the next dice roll and is consumed', async () => {
  const server = await startServer();
  try {
    await jsonRequest(server.baseUrl, '/api/apply', { method: 'POST', body: JSON.stringify({ tg_id: '901', username: 'rapunzel' }) });
    await jsonRequest(server.baseUrl, '/api/admin/approve-user', { method: 'POST', body: JSON.stringify({ admin_tg_id: '341995937', tg_id: '901' }) });
    await dbRun("UPDATE users SET next_roll_doubled = 1 WHERE tg_id = '901'");

    const roll = await jsonRequest(server.baseUrl, '/api/roll', { method: 'POST', body: JSON.stringify({ tg_id: '901' }) });
    assert.equal(roll.roll_doubled, true);
    assert.equal(roll.dice, roll.raw_dice * 2);
    const state = await jsonRequest(server.baseUrl, '/api/me/901?username=rapunzel');
    assert.equal(state.user.next_roll_doubled, false);
  } finally {
    await server.close();
  }
});

test('lucky choices stay available per player even for reused bonus tasks', async () => {
  const server = await startServer();
  try {
    const reset = await jsonRequest(server.baseUrl, '/api/admin/reset-round', { method: 'POST', body: JSON.stringify({ admin_tg_id: '341995937' }) });
    const luckyCell = reset.lucky_cells[0];

    for (const [tgId, username] of [['911', 'lucky_one'], ['912', 'lucky_two'], ['913', 'lucky_three'], ['914', 'lucky_four']]) {
      await jsonRequest(server.baseUrl, '/api/apply', { method: 'POST', body: JSON.stringify({ tg_id: tgId, username }) });
      await jsonRequest(server.baseUrl, '/api/admin/approve-user', { method: 'POST', body: JSON.stringify({ admin_tg_id: '341995937', tg_id: tgId }) });
      await dbRun(`UPDATE users SET current_cell = ${luckyCell}, dice_frozen = 1, pending_lucky_cell = ${luckyCell} WHERE tg_id = '${tgId}'`);
    }

    const state = await jsonRequest(server.baseUrl, '/api/me/911?username=lucky_one');
    assert.deepEqual(state.pendingLucky.options, [
      'Раскрасить что угодно вне заданий',
      'Взять картинку формата менее А4'
    ]);

    for (const [choice, firstTgId, secondTgId] of [
      ['Раскрасить что угодно вне заданий', '911', '912'],
      ['Взять картинку формата менее А4', '913', '914']
    ]) {
      const first = await jsonRequest(server.baseUrl, '/api/lucky-choice', {
        method: 'POST',
        body: JSON.stringify({ tg_id: firstTgId, choice })
      });
      assert.ok(first.task.id);
      assert.equal(first.task.text_task, choice);
      const notifications = await jsonRequest(server.baseUrl, `/api/notifications/${firstTgId}`);
      assert.match(notifications.events[0].message, /Бонусная клетка/);
      assert.match(notifications.events[0].message, new RegExp(choice));

      const second = await jsonRequest(server.baseUrl, '/api/lucky-choice', {
        method: 'POST',
        body: JSON.stringify({ tg_id: secondTgId, choice })
      });
      assert.ok(second.task.id);
      assert.equal(second.task.id, first.task.id);
      assert.equal(second.task.text_task, choice);
    }
  } finally {
    await server.close();
  }
});
