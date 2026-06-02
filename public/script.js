const tgApp = window.Telegram?.WebApp;
if (tgApp) {
  tgApp.ready();
  tgApp.expand();
}

const query = new URLSearchParams(window.location.search);
const tgUser = tgApp?.initDataUnsafe?.user;
const tgId = String(tgUser?.id || query.get('tg_id') || '').trim();
const tgUsername = String(tgUser?.username || tgUser?.first_name || query.get('username') || `user_${tgId}`).trim();

const els = {
  connectionBadge: document.getElementById('connectionBadge'),
  waitingScreen: document.getElementById('waitingScreen'),
  waitingTgId: document.getElementById('waitingTgId'),
  gameScreen: document.getElementById('gameScreen'),
  adminPanel: document.getElementById('adminPanel'),
  username: document.getElementById('username'),
  currentCell: document.getElementById('currentCell'),
  diceState: document.getElementById('diceState'),
  routeRunner: document.getElementById('routeRunner'),
  routeFill: document.getElementById('routeFill'),
  rollBtn: document.getElementById('rollBtn'),
  diceHint: document.getElementById('diceHint'),
  taskText: document.getElementById('taskText'),
  taskStatus: document.getElementById('taskStatus'),
  submitForm: document.getElementById('submitForm'),
  workImage: document.getElementById('workImage'),
  submitBtn: document.getElementById('submitBtn'),
  ticketsLine: document.getElementById('ticketsLine'),
  finalistLine: document.getElementById('finalistLine'),
  pendingUsers: document.getElementById('pendingUsers'),
  pendingSubmissions: document.getElementById('pendingSubmissions'),
  allUsers: document.getElementById('allUsers'),
  ticketsExport: document.getElementById('ticketsExport'),
  refreshExportBtn: document.getElementById('refreshExportBtn'),
  globalResetBtn: document.getElementById('globalResetBtn'),
  toast: document.getElementById('toast')
};

let state = null;
let pollingTimer = null;
let lastSubmissionStatus = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;'
  }[char]));
}

function showToast(message, duration = 3200) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.add('hidden'), duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function progressPercent(cell) {
  return Math.max(0, Math.min(100, Number(cell || 0)));
}

function drawProgress(cell) {
  const percent = progressPercent(cell);
  els.routeFill.style.width = `${percent}%`;
  els.routeRunner.style.left = `${percent}%`;
}

function renderTickets(tickets = []) {
  const numbers = tickets.map((ticket) => `№${ticket.ticket_number}${ticket.type === 'bonus' ? '★' : ''}`);
  els.ticketsLine.textContent = numbers.length
    ? `Мои Красочки: ${numbers.join(', ')} (Всего: ${numbers.length} шт.)`
    : 'Мои Красочки: пока нет (Всего: 0 шт.)';
}

function renderTask(submission) {
  els.submitForm.classList.add('hidden');
  els.submitBtn.disabled = false;
  els.taskStatus.textContent = '';

  if (!submission) {
    els.taskText.textContent = 'Бросьте кубик, чтобы получить задание.';
    els.taskText.classList.add('muted');
    return;
  }

  els.taskText.classList.remove('muted');
  els.taskText.textContent = submission.text_task;

  if (submission.status === 'pending' && !submission.image_name) {
    els.taskStatus.textContent = 'Задание получено. Загрузите фото выполненной работы.';
    els.submitForm.classList.remove('hidden');
    return;
  }

  if (submission.status === 'pending' && submission.image_name) {
    els.taskStatus.textContent = 'Фото отправлено. Ожидание проверки администратором...';
    return;
  }

  if (submission.status === 'rejected') {
    els.taskStatus.textContent = `Работа отклонена: ${submission.admin_comment || 'без комментария'}. Исправьте и отправьте новое фото.`;
    els.submitForm.classList.remove('hidden');
  }
}

function render() {
  if (!state?.user) return;
  const { user, activeSubmission, tickets, is_finalist: isFinalist } = state;

  if (Number(user.is_approved) !== 1) {
    els.waitingScreen.classList.remove('hidden');
    els.gameScreen.classList.add('hidden');
    els.adminPanel.classList.add('hidden');
    els.waitingTgId.textContent = user.tg_id;
    return;
  }

  els.waitingScreen.classList.add('hidden');
  els.gameScreen.classList.remove('hidden');
  els.username.textContent = user.username || `ID ${user.tg_id}`;
  els.currentCell.textContent = `${user.current_cell}/100`;
  els.diceState.textContent = Number(user.dice_frozen) === 1 ? 'Ожидание проверки' : 'Готов';
  drawProgress(user.current_cell);
  renderTask(activeSubmission);
  renderTickets(tickets);

  const frozen = Number(user.dice_frozen) === 1;
  const finished = Number(user.current_cell) >= 100;
  els.rollBtn.disabled = frozen || finished;
  els.rollBtn.classList.toggle('wait', frozen);
  els.rollBtn.textContent = frozen ? '⏳ Ожидание проверки...' : finished ? '🏁 Финиш!' : '🎲 Бросить кубик';
  els.diceHint.textContent = finished
    ? 'Вы достигли 100-й клетки. Поздравляем!'
    : frozen
      ? 'Администратор проверяет работу. Статус обновляется каждые 10 секунд.'
      : 'После броска кубик заморозится до проверки задания.';
  els.finalistLine.classList.toggle('hidden', !isFinalist);

  if (user.role === 'admin') {
    els.adminPanel.classList.remove('hidden');
    loadAdminPanel().catch((error) => showToast(error.message));
  } else {
    els.adminPanel.classList.add('hidden');
  }
}

async function loadState() {
  if (!tgId) {
    els.waitingScreen.classList.remove('hidden');
    els.waitingTgId.textContent = 'не найден';
    showToast('Откройте WebApp из Telegram или добавьте ?tg_id=... для теста');
    return;
  }

  els.connectionBadge.textContent = tgApp ? 'Telegram WebApp активен' : 'Тестовый режим';
  state = await api(`/api/me/${encodeURIComponent(tgId)}?username=${encodeURIComponent(tgUsername)}`);
  lastSubmissionStatus = state.activeSubmission?.status || lastSubmissionStatus;
  render();
  startPolling();
}

async function rollDice() {
  try {
    els.rollBtn.disabled = true;
    const result = await api('/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId })
    });
    showToast(`Выпало ${result.dice}. Вы перешли на клетку ${result.current_cell}.`);
    await loadState();
  } catch (error) {
    showToast(error.message);
    await loadState().catch(() => {});
  }
}

async function submitWork(event) {
  event.preventDefault();
  if (!els.workImage.files[0]) return showToast('Выберите картинку для отправки');

  const formData = new FormData();
  formData.append('tg_id', tgId);
  formData.append('work_image', els.workImage.files[0]);

  try {
    els.submitBtn.disabled = true;
    await api('/api/submit', { method: 'POST', body: formData });
    els.workImage.value = '';
    showToast('Фото отправлено на проверку');
    await loadState();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.submitBtn.disabled = false;
  }
}

function startPolling() {
  if (pollingTimer || !tgId) return;
  pollingTimer = window.setInterval(checkStatus, 10000);
}

async function checkStatus() {
  try {
    if (!state?.user || Number(state.user.is_approved) !== 1) return;
    const data = await api(`/api/check-status/${encodeURIComponent(tgId)}`);
    const submission = data.submission;
    if (!submission) return;

    if (submission.status === 'approved' && lastSubmissionStatus !== 'approved') {
      showToast('Работа одобрена! Красочка выдана, кубик снова доступен.', 5000);
      lastSubmissionStatus = 'approved';
      await loadState();
    } else if (submission.status === 'rejected' && lastSubmissionStatus !== 'rejected') {
      window.alert(`Работа отклонена. Комментарий: ${submission.admin_comment || 'без комментария'}`);
      lastSubmissionStatus = 'rejected';
      await loadState();
    }
  } catch (error) {
    console.warn('Polling error:', error.message);
  }
}

async function loadAdminPanel() {
  const adminParam = `admin_tg_id=${encodeURIComponent(tgId)}`;
  const [pendingUsers, users, submissions, exportData] = await Promise.all([
    api(`/api/admin/pending-users?${adminParam}`),
    api(`/api/admin/users?${adminParam}`),
    api(`/api/admin/submissions?${adminParam}`),
    api(`/api/admin/tickets-export?${adminParam}`)
  ]);

  renderPendingUsers(pendingUsers.users);
  renderAllUsers(users.users);
  renderPendingSubmissions(submissions.submissions);
  els.ticketsExport.value = exportData.text || '';
}

function renderPendingUsers(users) {
  els.pendingUsers.innerHTML = users.length ? '' : '<p class="muted">Новых заявок нет.</p>';
  for (const user of users) {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<strong>${escapeHtml(user.username || 'Без ника')}</strong><p class="muted">TG ID: ${escapeHtml(user.tg_id)}</p>`;

    const button = document.createElement('button');
    button.type = 'button';
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
      <label class="muted">Комментарий для отклонения
        <input type="text" data-comment="${submission.id}" placeholder="Что исправить?">
      </label>
    `;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'success';
    approve.textContent = 'Одобрить';
    approve.addEventListener('click', async () => {
      const result = await api('/api/admin/approve-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, submission_id: submission.id })
      });
      const ticketNumbers = result.issuedTickets.map((ticket) => `№${ticket.ticket_number}`).join(', ');
      showToast(`Работа одобрена. Выданы Красочки: ${ticketNumbers}`);
      await loadAdminPanel();
      if (submission.tg_id === tgId) await loadState();
    });

    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger';
    reject.textContent = 'Отклонить';
    reject.addEventListener('click', async () => {
      const comment = item.querySelector(`[data-comment="${submission.id}"]`).value.trim();
      if (!comment) return showToast('Введите комментарий для отклонения');
      await api('/api/admin/reject-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, submission_id: submission.id, admin_comment: comment })
      });
      showToast('Работа отклонена');
      await loadAdminPanel();
    });

    actions.append(approve, reject);
    item.append(actions);
    els.pendingSubmissions.append(item);
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
        <p class="muted">TG ID: ${escapeHtml(user.tg_id)} · роль: ${escapeHtml(user.role)} · клетка: ${user.current_cell}/100 · Красочек: ${user.tickets_count || 0} · ${Number(user.is_approved) === 1 ? 'доступ открыт' : 'исключен/ожидает'} · кубик: ${Number(user.dice_frozen) === 1 ? 'заморожен' : 'готов'}</p>
      </div>
      <div class="player-tools">
        <label class="muted">Номер клетки
          <input type="number" min="0" max="100" value="${Number(user.current_cell || 0)}" data-cell-input="${escapeHtml(user.tg_id)}">
        </label>
      </div>
    `;

    const tools = item.querySelector('.player-tools');

    const changeCell = document.createElement('button');
    changeCell.type = 'button';
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
    resetDice.type = 'button';
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
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Исключить';
    remove.disabled = user.tg_id === '391995937';
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

    tools.append(changeCell, resetDice, remove);
    els.allUsers.append(item);
  }
}

async function refreshExport() {
  const exportData = await api(`/api/admin/tickets-export?admin_tg_id=${encodeURIComponent(tgId)}`);
  els.ticketsExport.value = exportData.text || '';
  showToast('Выгрузка обновлена');
}

async function globalReset() {
  if (!window.confirm('Точно выполнить полный вайп игры и удалить все загруженные картинки?')) return;
  await api('/api/admin/global-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId })
  });
  showToast('Глобальный сброс выполнен');
  await loadState();
}

els.rollBtn.addEventListener('click', rollDice);
els.submitForm.addEventListener('submit', submitWork);
els.refreshExportBtn.addEventListener('click', () => refreshExport().catch((error) => showToast(error.message)));
els.globalResetBtn.addEventListener('click', () => globalReset().catch((error) => showToast(error.message)));

loadState().catch((error) => showToast(error.message));
