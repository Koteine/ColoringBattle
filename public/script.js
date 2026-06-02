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
  remainingPrizes: document.getElementById('remainingPrizes'),
  raffleStatusPanel: document.getElementById('raffleStatusPanel'),
  raffleCountdown: document.getElementById('raffleCountdown'),
  countdownTime: document.getElementById('countdownTime'),
  winnerReveal: document.getElementById('winnerReveal'),
  scratchGrid: document.getElementById('scratchGrid'),
  winnersList: document.getElementById('winnersList'),
  pendingUsers: document.getElementById('pendingUsers'),
  pendingSubmissions: document.getElementById('pendingSubmissions'),
  allUsers: document.getElementById('allUsers'),
  ticketRegistry: document.getElementById('ticketRegistry'),
  grantTicketForm: document.getElementById('grantTicketForm'),
  grantTicketTgId: document.getElementById('grantTicketTgId'),
  ticketsExport: document.getElementById('ticketsExport'),
  raffleConfigForm: document.getElementById('raffleConfigForm'),
  raffleStartInput: document.getElementById('raffleStartInput'),
  raffleEndInput: document.getElementById('raffleEndInput'),
  totalPrizesInput: document.getElementById('totalPrizesInput'),
  raffleConfigHint: document.getElementById('raffleConfigHint'),
  refreshExportBtn: document.getElementById('refreshExportBtn'),
  globalResetBtn: document.getElementById('globalResetBtn'),
  confettiLayer: document.getElementById('confettiLayer'),
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
let countdownTimer = null;
const scratchers = new Map();

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

function formatCountdown(ms) {
  const safe = Math.max(0, ms);
  const days = Math.floor(safe / 86_400_000);
  const hours = Math.floor((safe % 86_400_000) / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return days > 0 ? `${days}д ${hours}ч ${minutes}м` : `${hours}ч ${minutes}м ${seconds}с`;
}

function toDatetimeLocal(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateCountdown(config) {
  window.clearInterval(countdownTimer);
  countdownTimer = null;
  const startMs = Date.parse(config?.raffle_start || '');
  if (!Number.isFinite(startMs)) return;
  const tick = () => {
    const left = startMs - Date.now();
    els.countdownTime.textContent = formatCountdown(left);
    if (left <= 0) loadRaffle(true, true).catch((error) => console.warn('Raffle reload after countdown:', error.message));
  };
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function renderWinners(results = []) {
  els.winnersList.innerHTML = results.length ? '' : '<div class="empty-state">Пока монетку никто не нашел.</div>';
  for (const winner of results) {
    const item = document.createElement('article');
    item.className = 'item winner-row';
    item.innerHTML = `
      <strong>🪙 ${escapeHtml(formatWinnerName(winner))} — Красочка №${escapeHtml(winner.ticket_number)}</strong>
      <span class="muted">${escapeHtml(new Date(winner.drawn_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</span>
    `;
    els.winnersList.append(item);
  }
}

function cardResultMarkup(ticket) {
  if (ticket.status === 'winner') {
    return '<div><div class="coin">🪙</div><p>МОНЕТКА!</p></div>';
  }
  if (ticket.status === 'scratched') return '<div>😢<p>Пусто</p></div>';
  return '<div><div class="coin">?</div><p>Что внутри?</p></div>';
}

function renderScratchCards(tickets = [], raffleActive = false) {
  if (!tickets.length) {
    els.scratchGrid.innerHTML = '<div class="empty-state">У вас пока нет Красочек для скретч-лотереи.</div>';
    return;
  }

  els.scratchGrid.innerHTML = '';
  scratchers.clear();
  for (const ticket of tickets) {
    const card = document.createElement('article');
    const revealed = ticket.status !== 'active';
    card.className = `scratch-card ${revealed ? 'revealed' : ''} ${ticket.status === 'winner' ? 'won' : ''} ${ticket.status === 'scratched' ? 'lost' : ''}`;
    card.dataset.ticketNumber = ticket.ticket_number;
    card.innerHTML = `
      <div class="scratch-prize">${cardResultMarkup(ticket)}</div>
      <canvas aria-label="Скретч-слой Красочки №${escapeHtml(ticket.ticket_number)}"></canvas>
      <div class="scratch-label">Красочка №${escapeHtml(ticket.ticket_number)}${ticket.type === 'bonus' ? '★' : ''}</div>
    `;
    els.scratchGrid.append(card);
    if (!revealed && raffleActive) setupScratchCanvas(card, ticket);
    if (!raffleActive && !revealed) card.querySelector('.scratch-label').textContent = 'Ждем старта лотереи';
  }
}

function setupScratchCanvas(card, ticket) {
  const canvas = card.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let submitted = false;
  let lastCheck = 0;

  const paintCover = () => {
    const rect = card.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    gradient.addColorStop(0, '#c6ccd8');
    gradient.addColorStop(.45, '#f1f3f7');
    gradient.addColorStop(1, '#9ca3af');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = 'rgba(55,33,63,.72)';
    ctx.font = '900 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Сотри меня', rect.width / 2, rect.height / 2 - 6);
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillText('найди монетку', rect.width / 2, rect.height / 2 + 18);
  };

  const scratchAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointer = event.touches?.[0] || event;
    const x = pointer.clientX - rect.left;
    const y = pointer.clientY - rect.top;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(24, rect.width * .12), 0, Math.PI * 2);
    ctx.fill();
  };

  const scratchedPercent = () => {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    for (let index = 3; index < pixels.length; index += 16) {
      if (pixels[index] < 32) transparent += 1;
    }
    return transparent / (pixels.length / 16);
  };

  const maybeSubmit = async () => {
    if (submitted || Date.now() - lastCheck < 180) return;
    lastCheck = Date.now();
    if (scratchedPercent() < .5) return;
    submitted = true;
    card.classList.add('revealed');
    try {
      const data = await api('/api/raffle/scratch-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tg_id: tgId, ticket_number: ticket.ticket_number })
      });
      const prize = card.querySelector('.scratch-prize');
      if (data.result === 'win') {
        card.classList.add('won');
        prize.innerHTML = '<div><div class="coin">🪙</div><p>МОНЕТКА!</p></div>';
        showToast('🎉 Вы нашли монетку и выиграли приз!', 5200);
        launchConfetti();
        await loadNews().catch(() => {});
      } else {
        card.classList.add('lost');
        prize.innerHTML = '<div>😢<p>Пусто</p></div>';
        showToast('В этой Красочке пусто. Попробуйте следующую!');
      }
      await loadState().catch(() => {});
      await loadRaffle(true, true);
    } catch (error) {
      submitted = false;
      card.classList.remove('revealed');
      showToast(error.message);
    }
  };

  const start = (event) => {
    if (submitted) return;
    drawing = true;
    scratchAt(event);
    event.preventDefault();
  };
  const move = (event) => {
    if (!drawing || submitted) return;
    scratchAt(event);
    maybeSubmit();
    event.preventDefault();
  };
  const stop = () => {
    drawing = false;
    maybeSubmit();
  };

  paintCover();
  if (window.PointerEvent) {
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  } else {
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', stop);
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', stop);
  }
  scratchers.set(ticket.ticket_number, { paintCover });
}

function launchConfetti() {
  const colors = ['#ffafcc', '#bde0fe', '#ffd166', '#caffbf', '#cdb4db', '#fb6f92'];
  for (let i = 0; i < 72; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * .35}s`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    els.confettiLayer.append(piece);
    window.setTimeout(() => piece.remove(), 2200);
  }
}

async function loadRaffle(force = true, animateNew = false) {
  const now = Date.now();
  if (!force && now - raffleLoadedAt < 2500) return;
  const data = await api('/api/raffle/status');
  raffleLoadedAt = now;

  els.totalTickets.textContent = data.total_tickets || 0;
  els.activeTickets.textContent = data.active_tickets || 0;
  els.remainingPrizes.textContent = data.remaining_prizes || 0;
  renderWinners(data.results || []);

  els.raffleCountdown.classList.toggle('hidden', !data.is_before_start);
  if (data.is_before_start) updateCountdown(data.config);
  else window.clearInterval(countdownTimer);

  if (!data.is_configured) {
    els.winnerReveal.textContent = 'Лотерея еще не настроена администратором.';
  } else if (data.is_before_start) {
    els.winnerReveal.textContent = 'Подготовьте Красочки — скоро можно будет стирать!';
  } else if (data.is_active) {
    els.winnerReveal.textContent = 'Лотерея идет! Стирайте Красочки и ищите золотую монетку.';
  } else {
    els.winnerReveal.textContent = 'Окно лотереи закрыто.';
  }

  renderScratchCards(state?.tickets || [], Boolean(data.is_active));

  const latest = data.latest_winner || null;
  if (latest && latest.id !== lastRaffleWinnerId) {
    lastRaffleWinnerId = latest.id;
    if (animateNew) launchConfetti();
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
  const [pendingUsers, users, submissions, exportData, ticketData, raffleConfig] = await Promise.all([
    api(`/api/admin/pending-users?${adminParam}`),
    api(`/api/admin/users?${adminParam}`),
    api(`/api/admin/submissions?${adminParam}`),
    api(`/api/admin/tickets-export?${adminParam}`),
    api(`/api/admin/tickets?${adminParam}`),
    api(`/api/admin/raffle-config?${adminParam}`)
  ]);

  renderPendingUsers(pendingUsers.users);
  renderAllUsers(users.users);
  renderPendingSubmissions(submissions.submissions);
  renderTicketRegistry(ticketData.tickets || []);
  els.ticketsExport.value = exportData.text || '';
  renderRaffleConfig(raffleConfig);
}

function renderRaffleConfig(data) {
  const config = data?.config || {};
  els.raffleStartInput.value = toDatetimeLocal(config.raffle_start);
  els.raffleEndInput.value = toDatetimeLocal(config.raffle_end);
  els.totalPrizesInput.value = Number(config.total_prizes || 0);
  els.raffleConfigHint.textContent = `Осталось призов: ${Number(config.remaining_prizes || 0)} · выдано побед: ${Number(data?.winner_tickets || 0)} · статус: ${data?.is_active ? 'идет сейчас' : data?.is_before_start ? 'ждет старта' : data?.is_finished ? 'завершена' : 'не настроена'}`;
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

async function saveRaffleConfig(event) {
  event.preventDefault();
  const payload = {
    admin_tg_id: tgId,
    raffle_start: els.raffleStartInput.value ? new Date(els.raffleStartInput.value).toISOString() : '',
    raffle_end: els.raffleEndInput.value ? new Date(els.raffleEndInput.value).toISOString() : '',
    total_prizes: els.totalPrizesInput.value
  };
  const data = await api('/api/admin/raffle-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  renderRaffleConfig(data);
  showToast('Настройки лотереи сохранены');
  await loadRaffle(true).catch(() => {});
}

async function globalReset() {
  if (!window.confirm('ТОЧНО СБРОС? Это полностью уничтожит текущий сезон!')) return;
  await api('/api/admin/global-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId })
  });
  showToast('Глобальный сброс выполнен');
  raffleLoadedAt = 0;
  lastRaffleWinnerId = null;
  scratchers.clear();
  await loadState();
  await loadRaffle(true).catch(() => {});
  await loadNews().catch(() => {});
}

els.applyBtn.addEventListener('click', applyForGame);
els.rollBtn.addEventListener('click', rollDice);
els.submitForm.addEventListener('submit', submitWork);
els.grantTicketForm.addEventListener('submit', (event) => grantTicket(event).catch((error) => showToast(error.message)));
els.raffleConfigForm.addEventListener('submit', (event) => saveRaffleConfig(event).catch((error) => showToast(error.message)));
els.refreshExportBtn.addEventListener('click', () => refreshExport().catch((error) => showToast(error.message)));
els.globalResetBtn.addEventListener('click', () => globalReset().catch((error) => showToast(error.message)));

document.querySelectorAll('.admin-accordion-toggle').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.closest('.admin-accordion');
    const isOpen = section.classList.toggle('open');
    button.setAttribute('aria-expanded', String(isOpen));
  });
});
document.querySelectorAll('.nav-btn').forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

loadState().catch((error) => showToast(error.message));
