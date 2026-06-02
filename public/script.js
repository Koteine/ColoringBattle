const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const query = new URLSearchParams(window.location.search);
const tgUser = tg?.initDataUnsafe?.user;
const tgId = String(tgUser?.id || query.get('tg_id') || '');
const tgUsername = tgUser?.username || tgUser?.first_name || query.get('username') || '';

const els = {
  waitingScreen: document.getElementById('waitingScreen'),
  waitingTgId: document.getElementById('waitingTgId'),
  gameScreen: document.getElementById('gameScreen'),
  adminPanel: document.getElementById('adminPanel'),
  username: document.getElementById('username'),
  currentCell: document.getElementById('currentCell'),
  diceState: document.getElementById('diceState'),
  board: document.getElementById('board'),
  rollBtn: document.getElementById('rollBtn'),
  rollInfo: document.getElementById('rollInfo'),
  taskCard: document.getElementById('taskCard'),
  taskTitle: document.getElementById('taskTitle'),
  taskText: document.getElementById('taskText'),
  taskStatus: document.getElementById('taskStatus'),
  submitForm: document.getElementById('submitForm'),
  workImage: document.getElementById('workImage'),
  submitBtn: document.getElementById('submitBtn'),
  pendingUsers: document.getElementById('pendingUsers'),
  allUsers: document.getElementById('allUsers'),
  pendingSubmissions: document.getElementById('pendingSubmissions'),
  manualAddForm: document.getElementById('manualAddForm'),
  manualTgId: document.getElementById('manualTgId'),
  refreshBtn: document.getElementById('refreshBtn'),
  resetBtn: document.getElementById('resetBtn'),
  toast: document.getElementById('toast')
};

let state = null;
let lastSubmissionStatus = null;
let pollingTimer = null;

function showToast(message, timeout = 3500) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.add('hidden'), timeout);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ошибка API');
  return data;
}

function drawBoard(currentCell) {
  els.board.innerHTML = '';
  for (let cellNumber = 1; cellNumber <= 100; cellNumber += 1) {
    const cell = document.createElement('div');
    cell.className = `cell${cellNumber === Number(currentCell) ? ' active' : ''}`;
    cell.textContent = cellNumber;
    els.board.append(cell);
  }
}

function renderTask(submission) {
  if (!submission) {
    els.taskCard.classList.add('hidden');
    els.rollBtn.disabled = Number(state.user.dice_frozen) === 1;
    els.rollInfo.textContent = els.rollBtn.disabled ? 'Кубик заморожен до проверки.' : 'Можно бросить кубик.';
    return;
  }

  els.taskCard.classList.remove('hidden');
  els.taskTitle.textContent = `Клетка ${submission.cell}`;
  els.taskText.textContent = submission.text_task;

  const isRejected = submission.status === 'rejected';
  const isUploaded = Boolean(submission.image_name) && !isRejected;
  els.rollBtn.disabled = true;
  els.submitBtn.disabled = isUploaded;
  els.workImage.disabled = isUploaded;
  els.submitForm.classList.toggle('hidden', isUploaded);

  if (isRejected) {
    els.taskStatus.textContent = `Работа отклонена: ${submission.admin_comment || 'исправьте и отправьте снова.'}`;
  } else if (isUploaded) {
    els.taskStatus.textContent = 'Фото отправлено. Ожидайте проверку администратора.';
  } else {
    els.taskStatus.textContent = 'Загрузите фото выполненной работы.';
  }

  els.diceState.textContent = 'Заморожен';
  els.rollInfo.textContent = 'Кубик разблокируется после одобрения работы.';
}

function render() {
  const user = state.user;
  els.waitingTgId.textContent = user.tg_id;

  if (Number(user.is_approved) !== 1) {
    els.waitingScreen.classList.remove('hidden');
    els.gameScreen.classList.add('hidden');
    els.adminPanel.classList.add('hidden');
    return;
  }

  els.waitingScreen.classList.add('hidden');
  els.gameScreen.classList.remove('hidden');
  els.username.textContent = user.username || `ID ${user.tg_id}`;
  els.currentCell.textContent = `${user.current_cell} / 100`;
  els.diceState.textContent = Number(user.dice_frozen) === 1 ? 'Заморожен' : 'Готов';
  drawBoard(user.current_cell);
  renderTask(state.activeSubmission);

  if (user.role === 'admin') {
    els.adminPanel.classList.remove('hidden');
    loadAdminPanel();
  } else {
    els.adminPanel.classList.add('hidden');
  }
}

async function loadState() {
  if (!tgId) {
    els.waitingScreen.classList.remove('hidden');
    els.waitingTgId.textContent = 'не найден';
    showToast('Откройте приложение из Telegram или добавьте ?tg_id=... для теста');
    return;
  }

  state = await api(`/api/me/${encodeURIComponent(tgId)}?username=${encodeURIComponent(tgUsername)}`);
  lastSubmissionStatus = state.activeSubmission?.status || lastSubmissionStatus;
  render();
  startPolling();
}

async function rollDice() {
  els.rollBtn.disabled = true;
  const result = await api('/api/roll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tg_id: tgId })
  });
  showToast(`Выпало ${result.dice}. Новая клетка: ${result.current_cell}`);
  await loadState();
}

async function submitWork(event) {
  event.preventDefault();
  if (!els.workImage.files[0]) return showToast('Выберите фото работы');

  const formData = new FormData();
  formData.append('tg_id', tgId);
  formData.append('work_image', els.workImage.files[0]);

  els.submitBtn.disabled = true;
  await api('/api/submit', { method: 'POST', body: formData });
  els.workImage.value = '';
  showToast('Фото отправлено на проверку');
  await loadState();
}

function startPolling() {
  if (pollingTimer || !tgId || !state || Number(state.user.is_approved) !== 1) return;
  pollingTimer = window.setInterval(checkStatus, 10000);
}

async function checkStatus() {
  try {
    const data = await api(`/api/check-status/${encodeURIComponent(tgId)}`);
    const submission = data.submission;
    if (!submission) return;

    if (submission.status === 'approved' && lastSubmissionStatus !== 'approved') {
      lastSubmissionStatus = 'approved';
      showToast('Работа одобрена! Можно ходить!', 5000);
      await loadState();
    }

    if (submission.status === 'rejected' && lastSubmissionStatus !== 'rejected') {
      lastSubmissionStatus = 'rejected';
      window.alert(`Работа отклонена. Комментарий администратора: ${submission.admin_comment || 'без комментария'}`);
      await loadState();
    }
  } catch (error) {
    console.warn('Polling error:', error.message);
  }
}

async function loadAdminPanel() {
  const adminParam = `admin_tg_id=${encodeURIComponent(tgId)}`;
  const [pendingUsers, allUsers, submissions] = await Promise.all([
    api(`/api/admin/pending-users?${adminParam}`),
    api(`/api/admin/users?${adminParam}`),
    api(`/api/admin/submissions?${adminParam}`)
  ]);
  renderPendingUsers(pendingUsers.users);
  renderAllUsers(allUsers.users);
  renderPendingSubmissions(submissions.submissions);
}

function renderPendingUsers(users) {
  els.pendingUsers.innerHTML = users.length ? '' : '<p class="muted">Новых заявок нет.</p>';
  for (const user of users) {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<strong>${escapeHtml(user.username || 'Без ника')}</strong><p class="muted">TG ID: ${escapeHtml(user.tg_id)}</p>`;
    const button = document.createElement('button');
    button.textContent = 'Одобрить';
    button.addEventListener('click', async () => {
      await api('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id })
      });
      showToast('Игрок одобрен');
      await loadAdminPanel();
    });
    item.append(button);
    els.pendingUsers.append(item);
  }
}

function renderAllUsers(users) {
  els.allUsers.innerHTML = users.length ? '' : '<p class="muted">Игроков пока нет.</p>';
  for (const user of users) {
    const item = document.createElement('article');
    item.className = 'item player-row';
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(user.username || 'Без ника')}</strong>
        <p class="muted">TG ID: ${escapeHtml(user.tg_id)} · роль: ${escapeHtml(user.role)} · ${Number(user.is_approved) === 1 ? 'доступ открыт' : 'доступ закрыт'} · кубик: ${Number(user.dice_frozen) === 1 ? 'заморожен' : 'готов'}</p>
      </div>
      <label class="muted">Текущая клетка
        <input type="number" min="0" max="100" value="${Number(user.current_cell || 0)}" data-cell-input="${escapeHtml(user.tg_id)}">
      </label>
    `;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const changeCell = document.createElement('button');
    changeCell.textContent = 'Изменить клетку';
    changeCell.addEventListener('click', async () => {
      const input = item.querySelector('input[type="number"]');
      await api('/api/admin/change-cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id, current_cell: input.value })
      });
      showToast('Клетка изменена');
      await loadAdminPanel();
      if (user.tg_id === tgId) await loadState();
    });

    const resetDice = document.createElement('button');
    resetDice.className = 'ghost';
    resetDice.textContent = 'Разморозить кубик';
    resetDice.addEventListener('click', async () => {
      await api('/api/admin/reset-dice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id })
      });
      showToast('Кубик разморожен');
      await loadAdminPanel();
      if (user.tg_id === tgId) await loadState();
    });

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Исключить';
    remove.disabled = user.role === 'admin' && user.tg_id === tgId;
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Исключить игрока ${user.username || user.tg_id}?`)) return;
      await api('/api/admin/remove-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id })
      });
      showToast('Игрок исключен');
      await loadAdminPanel();
    });

    actions.append(changeCell, resetDice, remove);
    item.append(actions);
    els.allUsers.append(item);
  }
}

function renderPendingSubmissions(submissions) {
  els.pendingSubmissions.innerHTML = submissions.length ? '' : '<p class="muted">Работ на проверке нет.</p>';
  for (const submission of submissions) {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `
      <strong>${escapeHtml(submission.username || submission.tg_id)} — клетка ${submission.cell}</strong>
      <p>${escapeHtml(submission.text_task)}</p>
      <a href="/uploads/${encodeURIComponent(submission.image_name)}" target="_blank" rel="noopener">
        <img src="/uploads/${encodeURIComponent(submission.image_name)}" alt="Работа игрока">
      </a>
    `;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.textContent = 'Одобрить';
    approve.addEventListener('click', async () => {
      await api('/api/admin/approve-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, submission_id: submission.id })
      });
      showToast('Работа одобрена');
      await loadAdminPanel();
    });

    const reject = document.createElement('button');
    reject.className = 'danger';
    reject.textContent = 'Отклонить';
    reject.addEventListener('click', async () => {
      const admin_comment = window.prompt('Комментарий для игрока:');
      if (!admin_comment) return;
      await api('/api/admin/reject-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, submission_id: submission.id, admin_comment })
      });
      showToast('Работа отклонена');
      await loadAdminPanel();
    });

    actions.append(approve, reject);
    item.append(actions);
    els.pendingSubmissions.append(item);
  }
}

async function resetGame() {
  if (!window.confirm('Полностью сбросить игру: обнулить клетки, удалить историю и картинки?')) return;
  await api('/api/admin/global-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId })
  });
  showToast('Глобальный сброс выполнен');
  await loadState();
}

els.rollBtn.addEventListener('click', () => rollDice().catch((error) => showToast(error.message)));
els.submitForm.addEventListener('submit', (event) => submitWork(event).catch((error) => {
  els.submitBtn.disabled = false;
  showToast(error.message);
}));
els.refreshBtn.addEventListener('click', () => loadState().catch((error) => showToast(error.message)));
els.manualAddForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/add-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_tg_id: tgId, tg_id: els.manualTgId.value })
    });
    els.manualTgId.value = '';
    showToast('Доступ одобрен');
    await loadAdminPanel();
  } catch (error) {
    showToast(error.message);
  }
});
els.resetBtn.addEventListener('click', () => resetGame().catch((error) => showToast(error.message)));

loadState().catch((error) => showToast(error.message));
