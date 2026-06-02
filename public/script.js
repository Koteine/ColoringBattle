const tgApp = window.Telegram?.WebApp;
if (tgApp) {
  tgApp.ready();
  tgApp.expand();
}

const query = new URLSearchParams(window.location.search);
const tgUser = tgApp?.initDataUnsafe?.user;
const tgId = String(tgUser?.id || query.get('tg_id') || '').trim();
const OWNER_TG_ID = document.body?.dataset?.ownerTgId || '341995937';
const tgUsername = String(tgUser?.username || tgUser?.first_name || query.get('username') || (tgId ? `user_${tgId}` : '')).trim();

const els = {
  welcomeScreen: document.getElementById('welcomeScreen'),
  welcomeText: document.getElementById('welcomeText'),
  applyBtn: document.getElementById('applyBtn'),
  waitingScreen: document.getElementById('waitingScreen'),
  waitingTgId: document.getElementById('waitingTgId'),
  gameScreen: document.getElementById('gameScreen'),
  paletteScreen: document.getElementById('paletteScreen'),
  raffleScreen: document.getElementById('raffleScreen'),
  adminPanel: document.getElementById('adminPanel'),
  bottomNav: document.getElementById('bottomNav'),
  adminTabBtn: document.getElementById('adminTabBtn'),
  username: document.getElementById('username'),
  currentCell: document.getElementById('currentCell'),
  diceState: document.getElementById('diceState'),
  routeRunner: document.getElementById('routeRunner'),
  routeFill: document.getElementById('routeFill'),
  rollBtn: document.getElementById('rollBtn'),
  diceFace: document.getElementById('diceFace'),
  diceHint: document.getElementById('diceHint'),
  newsTrack: document.getElementById('newsTrack'),
  taskText: document.getElementById('taskText'),
  taskStatus: document.getElementById('taskStatus'),
  submitForm: document.getElementById('submitForm'),
  workImage: document.getElementById('workImage'),
  submitBtn: document.getElementById('submitBtn'),
  finalistLine: document.getElementById('finalistLine'),
  paletteGrid: document.getElementById('paletteGrid'),
  totalTickets: document.getElementById('totalTickets'),
  activeTickets: document.getElementById('activeTickets'),
  magicPalette: document.getElementById('magicPalette'),
  winnerReveal: document.getElementById('winnerReveal'),
  raffleLog: document.getElementById('raffleLog'),
  pendingUsers: document.getElementById('pendingUsers'),
  pendingSubmissions: document.getElementById('pendingSubmissions'),
  allUsers: document.getElementById('allUsers'),
  ticketRegistry: document.getElementById('ticketRegistry'),
  grantTicketForm: document.getElementById('grantTicketForm'),
  grantTicketTgId: document.getElementById('grantTicketTgId'),
  ticketsExport: document.getElementById('ticketsExport'),
  drawWinnerBtn: document.getElementById('drawWinnerBtn'),
  refreshExportBtn: document.getElementById('refreshExportBtn'),
  globalResetBtn: document.getElementById('globalResetBtn'),
  toast: document.getElementById('toast')
};

const paintGradients = [
  'linear-gradient(135deg, #ffafcc, #ffc8dd)',
  'linear-gradient(135deg, #bde0fe, #a2d2ff)',
  'linear-gradient(135deg, #caffbf, #9bf6ff)',
  'linear-gradient(135deg, #fdffb6, #ffd6a5)',
  'linear-gradient(135deg, #cdb4db, #bdb2ff)',
  'linear-gradient(135deg, #f8c8dc, #f9dcc4)',
  'linear-gradient(135deg, #d0f4de, #e4c1f9)',
  'linear-gradient(135deg, #fbc4ab, #ffdab9)'
];

let state = null;
let activeTab = 'game';
let pollingTimer = null;
let lastSubmissionStatus = '';
let isRolling = false;
let raffleLoadedAt = 0;
let rafflePollingTimer = null;
let lastRaffleWinnerId = null;
let newsPollingTimer = null;

function isOwnerId(id) {
  return String(id || '').trim() === OWNER_TG_ID;
}

function hasAdminAccess(user) {
  return isOwnerId(tgId) || isOwnerId(user?.tg_id);
}

function canEnterApp(user) {
  return hasAdminAccess(user) || Number(user?.is_approved) === 1;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;'
  }[char]));
}

function showToast(message, duration = 3400) {
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

function showGate(screen) {
  els.welcomeScreen.classList.toggle('hidden', screen !== 'welcome');
  els.waitingScreen.classList.toggle('hidden', screen !== 'waiting');
  els.gameScreen.classList.add('hidden');
  els.paletteScreen.classList.add('hidden');
  els.raffleScreen.classList.add('hidden');
  els.adminPanel.classList.add('hidden');
  els.bottomNav.classList.add('hidden');
}

function setActiveTab(tab) {
  const adminAllowed = hasAdminAccess(state?.user);
  activeTab = tab === 'admin' && !adminAllowed ? 'game' : tab;

  els.gameScreen.classList.toggle('hidden', activeTab !== 'game');
  els.paletteScreen.classList.toggle('hidden', activeTab !== 'palette');
  els.raffleScreen.classList.toggle('hidden', activeTab !== 'raffle');
  els.adminPanel.classList.toggle('hidden', activeTab !== 'admin' || !adminAllowed);

  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  });

  if (activeTab === 'raffle') startRafflePolling(true);
  else stopRafflePolling();
  if (activeTab === 'admin' && adminAllowed) loadAdminPanel().catch((error) => showToast(error.message));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateDiceFace(value) {
  els.diceFace.dataset.value = String(Math.max(1, Math.min(6, Number(value || 1))));
}

function renderPalette(tickets = []) {
  if (!tickets.length) {
    els.paletteGrid.innerHTML = '<div class="empty-state">Палитра пока пустая. Выполните первое задание, чтобы получить Красочку.</div>';
    return;
  }

  els.paletteGrid.innerHTML = '';
  for (const [index, ticket] of tickets.entries()) {
    const card = document.createElement('article');
    card.className = 'paint-card';
    card.style.background = paintGradients[index % paintGradients.length];
    card.innerHTML = `
      <span>Красочка №${escapeHtml(ticket.ticket_number)}</span>
      <small>${ticket.type === 'bonus' ? 'Финишная бонусная' : 'За выполненное задание'}</small>
    `;
    els.paletteGrid.append(card);
  }
}


function renderNews(events = []) {
  if (!els.newsTrack) return;
  const messages = events.map((event) => String(event.message || '').trim()).filter(Boolean);
  if (!messages.length) messages.push('Пока тихо — первые новости появятся после одобрения работ.');
  els.newsTrack.innerHTML = '';
  const repeated = messages.length < 4 ? [...messages, ...messages, ...messages] : messages;
  for (const message of repeated) {
    const item = document.createElement('span');
    item.className = 'news-item';
    item.textContent = message;
    els.newsTrack.append(item);
  }
}

async function loadNews() {
  const data = await api('/api/news?limit=20');
  renderNews(data.events || []);
}

function startNewsPolling() {
  if (newsPollingTimer) return;
  loadNews().catch((error) => console.warn('News loading error:', error.message));
  newsPollingTimer = window.setInterval(() => {
    if (state?.user && canEnterApp(state.user)) loadNews().catch((error) => console.warn('News polling error:', error.message));
  }, 6000);
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
  if (state?.needs_application || !state?.user) {
    showGate('welcome');
    els.welcomeText.textContent = tgId
      ? `Ваш Telegram ID: ${tgId}. Нажмите кнопку, чтобы отправить заявку администратору.`
      : 'Откройте WebApp из Telegram или добавьте ?tg_id=... для теста.';
    els.applyBtn.disabled = !tgId;
    return;
  }

  const { user, activeSubmission, tickets, is_finalist: isFinalist } = state;
  const adminAccess = hasAdminAccess(user);

  if (!canEnterApp(user)) {
    showGate('waiting');
    els.waitingTgId.textContent = user.tg_id;
    return;
  }

  els.welcomeScreen.classList.add('hidden');
  els.waitingScreen.classList.add('hidden');
  els.bottomNav.classList.remove('hidden');
  els.adminTabBtn.classList.toggle('hidden', !adminAccess);
  startNewsPolling();

  els.username.textContent = user.username || `ID ${user.tg_id}`;
  els.currentCell.textContent = `${user.current_cell}/100`;
  els.diceState.textContent = Number(user.dice_frozen) === 1 ? 'Ждёт проверку' : 'Готов';
  drawProgress(user.current_cell);
  renderTask(activeSubmission);
  renderPalette(tickets);

  const frozen = Number(user.dice_frozen) === 1;
  const finished = Number(user.current_cell) >= 100;
  els.rollBtn.disabled = frozen || finished || isRolling;
  els.rollBtn.classList.toggle('frozen', frozen || finished);
  els.diceHint.textContent = finished
    ? 'Вы достигли 100-й клетки. Поздравляем!'
    : frozen
      ? (els.taskStatus.textContent || 'Кубик заморожен до проверки задания.')
      : 'Нажмите на кубик: он прокрутится и покажет выпавшее число.';
  els.finalistLine.classList.toggle('hidden', !isFinalist);

  if (!adminAccess && activeTab === 'admin') activeTab = 'game';
  setActiveTab(activeTab);
}

async function loadState() {
  if (!tgId) {
    state = { user: null, needs_application: true, tickets: [] };
    render();
    return;
  }

  state = await api(`/api/me/${encodeURIComponent(tgId)}?username=${encodeURIComponent(tgUsername)}`);
  lastSubmissionStatus = state.activeSubmission?.status || lastSubmissionStatus;
  render();
  startPolling();
}

async function applyForGame() {
  if (!tgId) return showToast('Не найден Telegram ID');
  els.applyBtn.disabled = true;
  try {
    state = await api('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId, username: tgUsername })
    });
    showToast(hasAdminAccess(state.user) ? 'Админский доступ открыт' : 'Заявка отправлена');
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.applyBtn.disabled = false;
  }
}

async function rollDice() {
  if (isRolling || els.rollBtn.disabled) return;
  isRolling = true;
  els.rollBtn.disabled = true;
  els.rollBtn.classList.add('rolling');

  const spinTimer = window.setInterval(() => updateDiceFace(Math.floor(Math.random() * 6) + 1), 120);
  const animationDone = new Promise((resolve) => window.setTimeout(resolve, 1500));

  try {
    const resultPromise = api('/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId })
    });
    const result = await resultPromise;
    await animationDone;
    updateDiceFace(result.dice);
    showToast(`Выпало ${result.dice}. Вы перешли на клетку ${result.current_cell}.`);
    await loadState();
  } catch (error) {
    await animationDone;
    showToast(error.message);
    await loadState().catch(() => {});
  } finally {
    window.clearInterval(spinTimer);
    els.rollBtn.classList.remove('rolling');
    isRolling = false;
    render();
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
    if (!state?.user || !canEnterApp(state.user)) {
      await loadState();
      return;
    }
    const data = await api(`/api/check-status/${encodeURIComponent(tgId)}`);
    const submission = data.submission;
    if (!submission) return;

    if (submission.status === 'approved' && lastSubmissionStatus !== 'approved') {
      showToast('Работа одобрена! Красочка добавлена в палитру, кубик снова доступен.', 5200);
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

function formatWinnerName(winner) {
  const username = String(winner?.username || '').trim();
  return username ? `@${username.replace(/^@/, '')}` : `ID ${winner?.tg_id || '—'}`;
}

function renderRaffleLog(results = []) {
  els.raffleLog.innerHTML = results.length ? '' : '<div class="empty-state">Победителей пока нет. Ждём первый розыгрыш!</div>';
  for (const winner of results) {
    const item = document.createElement('article');
    item.className = 'item winner-row';
    item.innerHTML = `
      <strong>${escapeHtml(winner.place_number)}-е место: №${escapeHtml(winner.ticket_number)} — ${escapeHtml(formatWinnerName(winner))}</strong>
      <span class="muted">${escapeHtml(new Date(winner.drawn_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))}</span>
    `;
    els.raffleLog.append(item);
  }
}

function animateRaffleWinner(winner) {
  if (!winner) return;
  const blobs = [...els.magicPalette.querySelectorAll('.paint-blob')];
  const blob = blobs[(Number(winner.place_number || 1) - 1) % blobs.length];
  blobs.forEach((item) => item.classList.remove('erasing'));
  void blob.offsetWidth;
  blob.classList.add('erasing');

  els.winnerReveal.classList.remove('show');
  els.winnerReveal.textContent = `Красочка №${winner.ticket_number} — ${formatWinnerName(winner)}!`;
  void els.winnerReveal.offsetWidth;
  window.setTimeout(() => els.winnerReveal.classList.add('show'), 420);
}

async function loadRaffle(force = true, animateNew = false) {
  const now = Date.now();
  if (!force && now - raffleLoadedAt < 2500) return;
  const data = await api('/api/raffle/status');
  raffleLoadedAt = now;

  els.totalTickets.textContent = data.total_tickets || 0;
  els.activeTickets.textContent = data.active_tickets || 0;
  renderRaffleLog(data.results || []);

  const latest = data.latest_winner || null;
  if (!latest) {
    els.winnerReveal.textContent = 'Ждём первую Красочку!';
    els.winnerReveal.classList.add('show');
    lastRaffleWinnerId = null;
    return;
  }

  if (lastRaffleWinnerId === null) {
    lastRaffleWinnerId = latest.id;
    els.winnerReveal.textContent = `Красочка №${latest.ticket_number} — ${formatWinnerName(latest)}!`;
    els.winnerReveal.classList.add('show');
    return;
  }

  if (latest.id !== lastRaffleWinnerId) {
    lastRaffleWinnerId = latest.id;
    if (animateNew) animateRaffleWinner(latest);
  }
}

function startRafflePolling(runImmediately = false) {
  if (runImmediately) loadRaffle(true, true).catch((error) => showToast(error.message));
  if (rafflePollingTimer) return;
  rafflePollingTimer = window.setInterval(() => {
    if (activeTab === 'raffle') loadRaffle(true, true).catch((error) => console.warn('Raffle polling error:', error.message));
  }, 3000);
}

function stopRafflePolling() {
  if (!rafflePollingTimer) return;
  window.clearInterval(rafflePollingTimer);
  rafflePollingTimer = null;
}

async function loadAdminPanel() {
  const adminParam = `admin_tg_id=${encodeURIComponent(tgId)}`;
  const [pendingUsers, users, submissions, exportData, ticketData] = await Promise.all([
    api(`/api/admin/pending-users?${adminParam}`),
    api(`/api/admin/users?${adminParam}`),
    api(`/api/admin/submissions?${adminParam}`),
    api(`/api/admin/tickets-export?${adminParam}`),
    api(`/api/admin/tickets?${adminParam}`)
  ]);

  renderPendingUsers(pendingUsers.users);
  renderAllUsers(users.users);
  renderPendingSubmissions(submissions.submissions);
  renderTicketRegistry(ticketData.tickets || []);
  els.ticketsExport.value = exportData.text || '';
}

function renderPendingUsers(users) {
  els.pendingUsers.innerHTML = users.length ? '' : '<p class="muted">Новых заявок нет.</p>';
  for (const user of users) {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<strong>${escapeHtml(user.username || 'Без ника')}</strong><p class="muted">TG ID: ${escapeHtml(user.tg_id)}</p>`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'success';
    approve.textContent = 'Одобрить';
    approve.addEventListener('click', async () => {
      await api('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id })
      });
      showToast('Игрок одобрен');
      await loadAdminPanel();
    });

    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger';
    reject.textContent = 'Отклонить';
    reject.addEventListener('click', async () => {
      if (!window.confirm(`Отклонить заявку ${user.username || user.tg_id}?`)) return;
      await api('/api/admin/reject-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, tg_id: user.tg_id })
      });
      showToast('Заявка отклонена');
      await loadAdminPanel();
    });

    actions.append(approve, reject);
    item.append(actions);
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
      await loadNews().catch(() => {});
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
    item.className = 'item player-accordion';
    const playerName = user.username ? `@${String(user.username).replace(/^@/, '')}` : 'Без ника';
    item.innerHTML = `
      <button class="player-summary" type="button" aria-expanded="false">
        <strong>${escapeHtml(playerName)} (${escapeHtml(user.tg_id)}) — Клетка ${Number(user.current_cell || 0)}</strong>
      </button>
      <div class="player-details">
        <div class="player-details-inner">
          <p class="muted player-meta">Роль: ${escapeHtml(user.role)} · Красочек: ${user.tickets_count || 0} · ${Number(user.is_approved) === 1 ? 'доступ открыт' : 'исключен/ожидает'} · кубик: ${Number(user.dice_frozen) === 1 ? 'заморожен' : 'готов'}</p>
          <div class="player-tools">
            <label class="muted">Номер клетки
              <input type="number" min="0" max="100" value="${Number(user.current_cell || 0)}" data-cell-input="${escapeHtml(user.tg_id)}">
            </label>
          </div>
        </div>
      </div>
    `;

    const summary = item.querySelector('.player-summary');
    summary.addEventListener('click', () => {
      const isOpen = item.classList.toggle('open');
      summary.setAttribute('aria-expanded', String(isOpen));
    });

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
      await loadRaffle(true).catch(() => {});
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
    remove.disabled = user.tg_id === OWNER_TG_ID;
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

function renderTicketRegistry(tickets = []) {
  els.ticketRegistry.innerHTML = tickets.length ? '' : '<p class="muted">Красочек пока нет.</p>';
  for (const ticket of tickets) {
    const item = document.createElement('article');
    item.className = 'item ticket-row';
    const owner = ticket.username ? `@${String(ticket.username).replace(/^@/, '')}` : `ID ${ticket.tg_id}`;
    item.innerHTML = `
      <div>
        <strong>Красочка №${escapeHtml(ticket.ticket_number)}${ticket.type === 'bonus' ? '★' : ''}</strong>
        <p class="muted">Владелец: ${escapeHtml(owner)} (${escapeHtml(ticket.tg_id)}) · статус: ${escapeHtml(ticket.status)} · клетка: ${Number(ticket.current_cell || 0)}</p>
      </div>
    `;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Отобрать';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Отобрать Красочку №${ticket.ticket_number}?`)) return;
      await api('/api/admin/remove-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, ticket_number: ticket.ticket_number })
      });
      showToast('Красочка удалена из реестра');
      await loadAdminPanel();
      await loadState().catch(() => {});
      await loadRaffle(true).catch(() => {});
    });

    item.append(remove);
    els.ticketRegistry.append(item);
  }
}

async function grantTicket(event) {
  event.preventDefault();
  const targetTgId = els.grantTicketTgId.value.trim();
  if (!targetTgId) return showToast('Введите Telegram ID игрока');

  const result = await api('/api/admin/grant-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId, tg_id: targetTgId })
  });
  els.grantTicketTgId.value = '';
  showToast(`Начислена Красочка №${result.ticket.ticket_number}`);
  await loadAdminPanel();
  await loadNews().catch(() => {});
  if (targetTgId === tgId) await loadState();
}

async function refreshExport() {
  const exportData = await api(`/api/admin/tickets-export?admin_tg_id=${encodeURIComponent(tgId)}`);
  els.ticketsExport.value = exportData.text || '';
  showToast('Выгрузка обновлена');
}

async function drawNextWinner() {
  if (!tgId) return showToast('Не найден Telegram ID администратора');
  els.drawWinnerBtn.disabled = true;
  try {
    const data = await api('/api/admin/draw-winner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_tg_id: tgId })
    });

    if (!data.winner) {
      showToast(data.message || 'Активных Красочек больше нет');
    } else {
      showToast(`${data.winner.place_number}-е место: Красочка №${data.winner.ticket_number} — ${formatWinnerName(data.winner)}`);
      lastRaffleWinnerId = data.winner.id - 1;
      await loadRaffle(true, true);
    }

    await loadAdminPanel().catch(() => {});
  } catch (error) {
    showToast(error.message);
  } finally {
    els.drawWinnerBtn.disabled = false;
  }
}

async function globalReset() {
  if (!window.confirm('Точно выполнить полный вайп игры и удалить все загруженные картинки?')) return;
  await api('/api/admin/global-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId })
  });
  showToast('Глобальный сброс выполнен');
  raffleLoadedAt = 0;
  lastRaffleWinnerId = null;
  await loadState();
  await loadRaffle(true).catch(() => {});
  await loadNews().catch(() => {});
}

els.applyBtn.addEventListener('click', applyForGame);
els.rollBtn.addEventListener('click', rollDice);
els.submitForm.addEventListener('submit', submitWork);
els.grantTicketForm.addEventListener('submit', (event) => grantTicket(event).catch((error) => showToast(error.message)));
els.drawWinnerBtn.addEventListener('click', () => drawNextWinner().catch((error) => showToast(error.message)));
els.refreshExportBtn.addEventListener('click', () => refreshExport().catch((error) => showToast(error.message)));
els.globalResetBtn.addEventListener('click', () => globalReset().catch((error) => showToast(error.message)));
document.querySelectorAll('.nav-btn').forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

loadState().catch((error) => showToast(error.message));
