const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const els = {
  locked: document.querySelector('#lockedScreen'),
  game: document.querySelector('#gameScreen'),
  admin: document.querySelector('#adminScreen'),
  myTgId: document.querySelector('#myTgId'),
  username: document.querySelector('#username'),
  cell: document.querySelector('#cell'),
  completed: document.querySelector('#completed'),
  board: document.querySelector('#board'),
  rollBtn: document.querySelector('#rollBtn'),
  rollHint: document.querySelector('#rollHint'),
  taskCard: document.querySelector('#taskCard'),
  taskTitle: document.querySelector('#taskTitle'),
  taskText: document.querySelector('#taskText'),
  taskMeta: document.querySelector('#taskMeta'),
  taskStatus: document.querySelector('#taskStatus'),
  submitForm: document.querySelector('#submitForm'),
  submission: document.querySelector('#submission'),
  pendingUsers: document.querySelector('#pendingUsers'),
  submissions: document.querySelector('#submissions'),
  refreshBtn: document.querySelector('#refreshBtn'),
  resetBtn: document.querySelector('#resetBtn'),
  toast: document.querySelector('#toast')
};

let state = null;
const devQuery = new URLSearchParams(location.search).toString();

function authUrl(path) {
  return devQuery ? `${path}?${devQuery}` : path;
}

async function api(path, options = {}) {
  const res = await fetch(authUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData || '',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  setTimeout(() => els.toast.classList.add('hidden'), 2800);
}

function drawBoard(currentCell) {
  els.board.innerHTML = '';
  for (let i = 1; i <= 100; i += 1) {
    const cell = document.createElement('div');
    cell.className = `cell${i === currentCell ? ' player' : ''}`;
    cell.textContent = i;
    els.board.append(cell);
  }
}

function renderTask(activeTask) {
  if (!activeTask) {
    els.taskCard.classList.add('hidden');
    els.rollBtn.disabled = false;
    els.rollHint.textContent = 'Нажмите кнопку, чтобы бросить кубик и получить новое задание.';
    return;
  }

  els.taskCard.classList.remove('hidden');
  els.taskTitle.textContent = `Клетка ${activeTask.cell}`;
  els.taskText.textContent = activeTask.text;
  els.taskMeta.textContent = `Сложность: ${activeTask.difficulty}. Выпало на кубике: ${activeTask.dice}.`;
  els.submission.value = activeTask.submission || '';
  els.rollBtn.disabled = true;
  els.rollHint.textContent = 'Кубик заблокирован до одобрения задания администратором.';

  const rejected = activeTask.status === 'rejected';
  const alreadySubmitted = Boolean(activeTask.submitted_at) && !rejected;
  els.submitForm.querySelector('button').disabled = alreadySubmitted;
  els.submission.disabled = alreadySubmitted;
  els.taskStatus.textContent = rejected
    ? `Работа отклонена. Комментарий: ${activeTask.admin_comment || 'исправьте и отправьте снова.'}`
    : alreadySubmitted
      ? 'Работа отправлена и находится на проверке.'
      : 'Сдайте работу, чтобы администратор мог ее проверить.';
}

function render() {
  const user = state.user;
  els.myTgId.textContent = user.tg_id;

  if (user.status !== 'active') {
    els.locked.classList.remove('hidden');
    els.game.classList.add('hidden');
    els.admin.classList.add('hidden');
    return;
  }

  els.locked.classList.add('hidden');
  els.game.classList.remove('hidden');
  els.username.textContent = user.username || `ID ${user.tg_id}`;
  els.cell.textContent = `${user.current_cell} / 100`;
  els.completed.textContent = user.completed_tasks;
  drawBoard(user.current_cell);
  renderTask(state.activeTask);

  if (user.role === 'admin') {
    els.admin.classList.remove('hidden');
    loadAdmin();
  } else {
    els.admin.classList.add('hidden');
  }
}

async function loadState() {
  state = await api('/api/me');
  render();
}

async function loadAdmin() {
  const [pending, feed] = await Promise.all([
    api('/api/admin/pending-users'),
    api('/api/admin/submissions')
  ]);
  renderPendingUsers(pending.users);
  renderSubmissions(feed.submissions);
}

function renderPendingUsers(users) {
  els.pendingUsers.innerHTML = users.length ? '' : '<p class="muted">Новых заявок нет.</p>';
  for (const user of users) {
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `<strong>${escapeHtml(user.username || 'Без ника')}</strong><p class="muted">Telegram ID: ${escapeHtml(user.tg_id)}</p>`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Одобрить';
    btn.addEventListener('click', async () => {
      await api(`/api/admin/users/${user.id}/approve`, { method: 'POST' });
      toast('Игрок одобрен');
      await loadAdmin();
    });
    item.append(wrapActions(btn));
    els.pendingUsers.append(item);
  }
}

function renderSubmissions(submissions) {
  els.submissions.innerHTML = submissions.length ? '' : '<p class="muted">Работ на проверке нет.</p>';
  for (const sub of submissions) {
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `
      <strong>${escapeHtml(sub.username || sub.tg_id)} — клетка ${sub.cell}</strong>
      <p>${escapeHtml(sub.task_text)}</p>
      <p class="notice">Работа: ${linkify(sub.submission)}</p>
    `;
    const approve = document.createElement('button');
    approve.className = 'primary';
    approve.textContent = 'Одобрить';
    approve.addEventListener('click', async () => {
      await api(`/api/admin/tasks/${sub.history_id}/approve`, { method: 'POST' });
      toast('Работа одобрена');
      await Promise.all([loadState(), loadAdmin()]);
    });

    const reject = document.createElement('button');
    reject.className = 'danger';
    reject.textContent = 'Отклонить';
    reject.addEventListener('click', async () => {
      const comment = prompt('Комментарий для игрока:');
      if (!comment) return;
      await api(`/api/admin/tasks/${sub.history_id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
      toast('Работа отклонена');
      await loadAdmin();
    });
    item.append(wrapActions(approve, reject));
    els.submissions.append(item);
  }
}

function wrapActions(...buttons) {
  const box = document.createElement('div');
  box.className = 'actions';
  box.append(...buttons);
  return box;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function linkify(value) {
  const safe = escapeHtml(value);
  if (/^https?:\/\//i.test(value)) return `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
  return safe;
}

els.rollBtn.addEventListener('click', async () => {
  els.rollBtn.disabled = true;
  const result = await api('/api/roll', { method: 'POST' });
  toast(`Выпало: ${result.dice}`);
  await loadState();
});

els.submitForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await api('/api/submit', { method: 'POST', body: JSON.stringify({ submission: els.submission.value }) });
  toast('Работа отправлена');
  await loadState();
});

els.refreshBtn.addEventListener('click', loadState);
els.resetBtn.addEventListener('click', async () => {
  if (!confirm('Точно выполнить глобальный сброс для всех игроков?')) return;
  await api('/api/admin/reset', { method: 'POST' });
  toast('Глобальный сброс выполнен');
  await loadState();
});

loadState().catch((error) => {
  els.locked.classList.remove('hidden');
  els.myTgId.textContent = tg?.initDataUnsafe?.user?.id || new URLSearchParams(location.search).get('tg_id') || 'не определен';
  toast(error.message);
});
