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
  whereScreen: document.getElementById('whereScreen'),
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
  taskActions: document.getElementById('taskActions'),
  rerollTaskBtn: document.getElementById('rerollTaskBtn'),
  luckyChoice: document.getElementById('luckyChoice'),
  submitForm: document.getElementById('submitForm'),
  submitStepTitle: document.getElementById('submitStepTitle'),
  submitStepHint: document.getElementById('submitStepHint'),
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
  topReactions: document.getElementById('topReactions'),
  leaderboardTable: document.getElementById('leaderboardTable'),
  pendingUsers: document.getElementById('pendingUsers'),
  pendingSubmissions: document.getElementById('pendingSubmissions'),
  allUsers: document.getElementById('allUsers'),
  ticketRegistry: document.getElementById('ticketRegistry'),
  roleNotice: document.getElementById('roleNotice'),
  gamePlayCard: document.getElementById('gamePlayCard'),
  taskCard: document.getElementById('taskCard'),
  paletteHint: document.getElementById('paletteHint'),
  taskAdminForm: document.getElementById('taskAdminForm'),
  taskAdminText: document.getElementById('taskAdminText'),
  taskAdminList: document.getElementById('taskAdminList'),
  grantTicketForm: document.getElementById('grantTicketForm'),
  grantTicketTgId: document.getElementById('grantTicketTgId'),
  ticketsExport: document.getElementById('ticketsExport'),
  raffleConfigForm: document.getElementById('raffleConfigForm'),
  raffleStartInput: document.getElementById('raffleStartInput'),
  raffleEndInput: document.getElementById('raffleEndInput'),
  totalPrizesInput: document.getElementById('totalPrizesInput'),
  raffleConfigHint: document.getElementById('raffleConfigHint'),
  refreshExportBtn: document.getElementById('refreshExportBtn'),
  resetRoundBtn: document.getElementById('resetRoundBtn'),
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
let leaderboardPlayers = [];
const scratchers = new Map();
const trapCells = new Set([13, 26, 39, 52, 65, 78, 91]);
const luckyCells = new Set([7, 21, 35, 49, 63, 77, 88]);

function getClientCellType(cell) {
  const normalized = Number(cell || 0);
  if (trapCells.has(normalized)) return 'trap';
  if (luckyCells.has(normalized)) return 'lucky';
  return 'ordinary';
}

const rainbowCovers = [
  ['#ff2d55', '#ff7a8a'],
  ['#ff8c00', '#ffd166'],
  ['#ffe14d', '#fff59d'],
  ['#23c552', '#9bf6a3'],
  ['#38bdf8', '#a5f3fc'],
  ['#2563eb', '#93c5fd'],
  ['#8b5cf6', '#d8b4fe']
];

function isOwnerId(id) {
  return String(id || '').trim() === OWNER_TG_ID;
}

function isModerator(user) {
  return user?.role === 'moderator';
}

function isPrivilegedUser(user) {
  return hasAdminAccess(user) || isModerator(user);
}

function hasAdminAccess(user) {
  return isOwnerId(tgId) || isOwnerId(user?.tg_id) || user?.role === 'admin';
}

function hasStaffAccess(user) {
  return hasAdminAccess(user) || isModerator(user);
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
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
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
  els.whereScreen.classList.add('hidden');
  els.adminPanel.classList.add('hidden');
  els.bottomNav.classList.add('hidden');
}

function setActiveTab(tab) {
  const adminAllowed = hasStaffAccess(state?.user);
  activeTab = tab === 'admin' && !adminAllowed ? 'game' : tab;

  els.gameScreen.classList.toggle('hidden', activeTab !== 'game');
  els.paletteScreen.classList.toggle('hidden', activeTab !== 'palette');
  els.raffleScreen.classList.toggle('hidden', activeTab !== 'raffle');
  els.whereScreen.classList.toggle('hidden', activeTab !== 'where');
  els.adminPanel.classList.toggle('hidden', activeTab !== 'admin' || !adminAllowed);

  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  });

  if (activeTab === 'raffle') startRafflePolling(true);
  else stopRafflePolling();
  if (activeTab === 'where') loadLeaderboard().catch((error) => showToast(error.message));
  if (activeTab === 'admin' && adminAllowed) loadAdminPanel().catch((error) => showToast(error.message));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateDiceFace(value) {
  els.diceFace.dataset.value = String(Math.max(1, Math.min(6, Number(value || 1))));
}

async function renderWorkArchive() {
  els.paletteGrid.classList.add('archive-mode');
  els.paletteHint.textContent = 'Проверка ожидающих работ и архив всех игроков со статистикой по клеткам и выполненным заданиям.';
  els.pendingSubmissions.innerHTML = '<article class="item archive-accordion open"><button type="button" class="archive-toggle"><strong>⏳ Ожидают одобрения</strong></button><div class="archive-panel"><div class="archive-inner"><div class="empty-state">Загружаем работы...</div></div></div></article>';
  els.paletteGrid.innerHTML = '<div class="empty-state">Загружаем архив...</div>';

  const [pendingData, archiveData] = await Promise.all([
    api(`/api/admin/submissions?admin_tg_id=${encodeURIComponent(tgId)}`),
    api(`/api/admin/work-archive?admin_tg_id=${encodeURIComponent(tgId)}`)
  ]);

  renderPendingSubmissions(pendingData.submissions || []);

  if (!archiveData.players?.length) {
    els.paletteGrid.innerHTML = '<article class="item archive-accordion open"><button type="button" class="archive-toggle"><strong>👥 Все игроки</strong></button><div class="archive-panel"><div class="archive-inner"><div class="empty-state">Одобренных работ пока нет.</div></div></div></article>';
    return;
  }

  els.paletteGrid.innerHTML = '';
  const archiveRoot = document.createElement('article');
  archiveRoot.className = 'item archive-accordion open';
  archiveRoot.innerHTML = '<button type="button" class="archive-toggle"><strong>👥 Все игроки</strong></button><div class="archive-panel"><div class="archive-inner"></div></div>';
  const archiveInner = archiveRoot.querySelector('.archive-inner');

  for (const player of archiveData.players) {
    const playerNode = document.createElement('article');
    playerNode.className = 'item archive-accordion';
    const username = player.username ? `@${String(player.username).replace(/^@/, '')}` : 'Без ника';
    const diceStatus = Number(player.dice_frozen) === 1 ? 'Заморожен (ждет проверки)' : 'Свободен';
    playerNode.innerHTML = `
      <button type="button" class="archive-toggle"><strong>${escapeHtml(username)} (ID: ${escapeHtml(player.tg_id)})</strong></button>
      <div class="archive-panel"><div class="archive-inner">
        <div class="item player-dossier">
          <p><strong>Текущая клетка:</strong> ${Number(player.current_cell || 0)}</p>
          <p><strong>Статус кубика:</strong> ${escapeHtml(diceStatus)}</p>
          <p><strong>Выполнено заданий:</strong> ${Number(player.approved_submissions_count || 0)}</p>
          <p><strong>Всего Красочек:</strong> ${Number(player.active_tickets_count || 0)}</p>
        </div>
      </div></div>`;
    const inner = playerNode.querySelector('.archive-inner');
    for (const work of player.works || []) {
      const workNode = document.createElement('article');
      workNode.className = 'item archive-accordion archive-work';
      const beforeUrl = `/uploads/${encodeURIComponent(work.photo_before)}`;
      const afterUrl = `/uploads/${encodeURIComponent(work.photo_after)}`;
      workNode.innerHTML = `<button type="button" class="archive-toggle"><strong>Клетка ${escapeHtml(work.cell)} — ${escapeHtml(work.text_task)}</strong></button><div class="archive-panel"><div class="archive-inner archive-photos"><div class="comparison-grid"><a class="comparison-photo" href="${beforeUrl}" target="_blank" rel="noopener"><strong>Фото ДО</strong><img src="${beforeUrl}" alt="Фото ДО"></a><a class="comparison-photo" href="${afterUrl}" target="_blank" rel="noopener"><strong>Фото ПОСЛЕ</strong><img src="${afterUrl}" alt="Фото ПОСЛЕ"></a></div></div></div>`;
      inner.append(workNode);
    }
    archiveInner.append(playerNode);
  }
  els.paletteGrid.append(archiveRoot);
}

function renderPalette(tickets = []) {
  els.pendingSubmissions.innerHTML = '';
  els.paletteGrid.classList.add('archive-mode');
  els.paletteHint.textContent = 'Личный архив: все ваши Красочки с заданиями и Фото ПОСЛЕ.';
  if (!tickets.length) {
    els.paletteGrid.innerHTML = '<div class="empty-state">Палитра пока пустая. Выполните первое задание, чтобы получить Красочку.</div>';
    return;
  }

  els.paletteGrid.innerHTML = '';
  for (const [index, ticket] of tickets.entries()) {
    const card = document.createElement('article');
    card.className = 'item archive-accordion player-ticket-archive';
    const hasWork = ticket.text_task && ticket.photo_after;
    const afterUrl = hasWork ? `/uploads/${encodeURIComponent(ticket.photo_after)}` : '';
    card.innerHTML = `
      <button type="button" class="archive-toggle" style="background:${paintGradients[index % paintGradients.length]}">
        <strong>Красочка №${escapeHtml(ticket.ticket_number)}</strong>
        <small>${ticket.type === 'bonus' ? 'Бонусная' : 'За задание'}</small>
      </button>
      <div class="archive-panel"><div class="archive-inner">
        ${hasWork ? `
          <p><strong>Квест:</strong> ${escapeHtml(ticket.text_task)}</p>
          <a class="comparison-photo player-after-photo" href="${afterUrl}" target="_blank" rel="noopener">
            <strong>Фото ПОСЛЕ</strong><img src="${afterUrl}" alt="Фото ПОСЛЕ для Красочки №${escapeHtml(ticket.ticket_number)}">
          </a>
        ` : '<p class="muted">Эта Красочка бонусная или выдана вручную — привязанной работы нет.</p>'}
      </div></div>
    `;
    els.paletteGrid.append(card);
  }
}


function formatHandle(username, fallbackId = '') {
  const clean = String(username || '').replace(/^@/, '').trim();
  return clean ? `@${clean}` : `ID ${fallbackId}`;
}

function renderLeaderboard(players = []) {
  leaderboardPlayers = players;
  const sortedByReactions = [...players]
    .map((player) => ({ ...player, total_reactions: Number(player.reactions_hearts || 0) + Number(player.reactions_coffee || 0) }))
    .filter((player) => player.total_reactions > 0)
    .sort((a, b) => b.total_reactions - a.total_reactions || Number(b.current_cell || 0) - Number(a.current_cell || 0))
    .slice(0, 3);

  els.topReactions.innerHTML = sortedByReactions.length ? '' : '<div class="empty-state">Топ поддержки появится после первых реакций.</div>';
  sortedByReactions.forEach((player, index) => {
    const card = document.createElement('article');
    card.className = 'reaction-champion';
    card.innerHTML = `
      <div class="place">${['🥇', '🥈', '🥉'][index]}</div>
      <strong class="glow-name">${escapeHtml(formatHandle(player.username, player.tg_id))}</strong>
      <p class="muted">${player.total_reactions} реакций · клетка ${Number(player.current_cell || 0)}</p>
    `;
    els.topReactions.append(card);
  });

  if (!players.length) {
    els.leaderboardTable.innerHTML = '<div class="empty-state">Одобренных игроков пока нет.</div>';
    return;
  }

  const reactionLeaders = new Set(sortedByReactions.map((player) => String(player.tg_id)));
  els.leaderboardTable.innerHTML = `
    <table class="where-table">
      <thead><tr><th>Игрок</th><th>Клетка</th><th>💖</th><th>☕</th></tr></thead>
      <tbody>${players.map((player) => {
        const isMe = String(player.tg_id) === String(tgId);
        const hearts = Number(player.reactions_hearts || 0);
        const coffee = Number(player.reactions_coffee || 0);
        const disabled = isMe ? ' disabled aria-disabled="true"' : '';
        const title = isMe ? ' title="Нельзя поддержать себя"' : '';
        return `<tr class="${isMe ? 'is-me' : ''}" data-player-id="${escapeHtml(player.tg_id)}">
          <td><strong class="${reactionLeaders.has(String(player.tg_id)) ? 'glow-name' : ''}">${escapeHtml(formatHandle(player.username, player.tg_id))}</strong>${isMe ? ' <span class="muted">это вы</span>' : ''}</td>
          <td>${Number(player.current_cell || 0)}/100</td>
          <td><button class="reaction-btn" type="button" data-react="heart" data-to-id="${escapeHtml(player.tg_id)}"${disabled}${title}>💖 ${hearts}</button></td>
          <td><button class="reaction-btn" type="button" data-react="coffee" data-to-id="${escapeHtml(player.tg_id)}"${disabled}${title}>☕ ${coffee}</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

async function loadLeaderboard() {
  els.leaderboardTable.innerHTML = '<div class="empty-state">Загружаем игроков...</div>';
  const data = await api('/api/game/leaderboard');
  renderLeaderboard(data.players || []);
}

async function sendReaction(toTgId, reactionType, button) {
  if (!tgId) return showToast('Не найден Telegram ID');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await api('/api/game/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_tg_id: tgId, to_tg_id: toTgId, reaction_type: reactionType })
    });
    const index = leaderboardPlayers.findIndex((player) => String(player.tg_id) === String(toTgId));
    if (index >= 0 && data.player) {
      leaderboardPlayers[index] = { ...leaderboardPlayers[index], ...data.player };
      renderLeaderboard(leaderboardPlayers);
    } else {
      await loadLeaderboard();
    }
    showToast(data.bonus_ticket ? `Поддержка засчитана! Игрок получил Красочку №${data.bonus_ticket.ticket_number}.` : 'Поддержка засчитана!');
    loadNews().catch(() => {});
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
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

function configureSubmitStep({ fieldName, title, hint, buttonText }) {
  els.workImage.name = fieldName;
  els.workImage.dataset.fieldName = fieldName;
  els.submitStepTitle.textContent = title;
  els.submitStepHint.textContent = hint;
  els.submitBtn.textContent = buttonText;
  els.submitForm.classList.remove('hidden');
}

function renderTask(submission) {
  els.submitForm.classList.add('hidden');
  els.taskActions.classList.add('hidden');
  els.luckyChoice.classList.add('hidden');
  els.submitBtn.disabled = false;
  els.taskStatus.textContent = '';

  if (!submission) {
    els.taskText.textContent = 'Бросьте кубик, чтобы получить задание.';
    els.taskText.classList.add('muted');
    return;
  }

  const canReroll = submission.status === 'pending'
    && !submission.photo_before
    && !submission.photo_after
    && getClientCellType(submission.cell) === 'ordinary';
  els.taskActions.classList.toggle('hidden', !canReroll);

  els.taskText.classList.remove('muted');
  els.taskText.textContent = submission.text_task;

  if (submission.status === 'rejected') {
    els.taskStatus.textContent = `Работа отклонена: ${submission.admin_comment || 'без комментария'}. Загрузите новую пару фото, начиная с Фото ДО.`;
    configureSubmitStep({
      fieldName: 'photo_before',
      title: 'Шаг 1: Зафиксируй начало работы',
      hint: 'Повторно загрузите Фото ДО — незакрашенную страницу перед новой попыткой. После этого Фото ПОСЛЕ нужно будет отправить заново.',
      buttonText: 'Отправить Фото ДО'
    });
    return;
  }

  if (submission.status === 'pending' && !submission.photo_before) {
    els.taskStatus.textContent = 'Задание получено. Сначала загрузите Фото ДО. Кубик останется замороженным.';
    configureSubmitStep({
      fieldName: 'photo_before',
      title: 'Шаг 1: Зафиксируй начало работы',
      hint: 'Загрузите Фото ДО — незакрашенную страницу перед началом раскрашивания.',
      buttonText: 'Отправить Фото ДО'
    });
    return;
  }

  if (submission.status === 'pending' && !submission.photo_after) {
    els.taskStatus.textContent = 'Фото ДО сохранено. Теперь раскрасьте страницу и загрузите Фото ПОСЛЕ.';
    configureSubmitStep({
      fieldName: 'photo_after',
      title: 'Шаг 2: Раскрашивание',
      hint: 'Загрузите Фото ПОСЛЕ — готовую раскрашенную страницу. Только после этого работа уйдет на проверку.',
      buttonText: 'Отправить Фото ПОСЛЕ'
    });
    return;
  }

  if (submission.status === 'pending') {
    els.taskStatus.textContent = 'Фото ДО и Фото ПОСЛЕ отправлены. Ожидание проверки администратором...';
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
  const adminAccess = hasStaffAccess(user);

  if (!canEnterApp(user)) {
    showGate('waiting');
    els.waitingTgId.textContent = user.tg_id;
    return;
  }

  els.welcomeScreen.classList.add('hidden');
  els.waitingScreen.classList.add('hidden');
  els.bottomNav.classList.remove('hidden');
  els.adminTabBtn.classList.toggle('hidden', !adminAccess);
  document.querySelectorAll('.owner-only').forEach((el) => el.classList.toggle('hidden', !hasAdminAccess(user)));
  const roleBlocked = isPrivilegedUser(user);
  els.roleNotice.classList.toggle('hidden', !roleBlocked);
  els.gamePlayCard.classList.toggle('hidden', roleBlocked);
  els.taskCard.classList.toggle('hidden', roleBlocked);
  startNewsPolling();

  els.username.textContent = user.username || `ID ${user.tg_id}`;
  els.currentCell.textContent = `${user.current_cell}/100`;
  els.diceState.textContent = Number(user.dice_frozen) === 1 ? 'Ждёт проверку' : 'Готов';
  drawProgress(user.current_cell);
  if (!roleBlocked) renderTask(activeSubmission);
  if (!activeSubmission && state.pendingLucky) {
    els.taskText.textContent = '🎉 Бонусная клетка! Выберите одно из двух условий.';
    els.taskText.classList.remove('muted');
    els.taskStatus.textContent = `Клетка ${state.pendingLucky.cell}: после выбора откроется стандартная форма загрузки.`;
    els.luckyChoice.classList.remove('hidden');
  }
  if (roleBlocked) renderWorkArchive().catch((error) => { els.paletteGrid.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; });
  else renderPalette(tickets);

  const frozen = Number(user.dice_frozen) === 1;
  const finished = Number(user.current_cell) >= 100;
  els.rollBtn.disabled = roleBlocked || frozen || finished || isRolling;
  els.rollBtn.classList.toggle('frozen', roleBlocked || frozen || finished);
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

function normalizeDiceValue(value) {
  return Math.max(1, Math.min(6, Number(value || 1)));
}

function animateDiceTo(serverDice) {
  const finalDice = normalizeDiceValue(serverDice);
  const animationSteps = 12;
  let step = 0;

  return new Promise((resolve) => {
    els.rollBtn.classList.add('rolling');

    const spinTimer = window.setInterval(() => {
      step += 1;

      if (step >= animationSteps) {
        window.clearInterval(spinTimer);
        updateDiceFace(finalDice);
        window.setTimeout(() => {
          els.rollBtn.classList.remove('rolling');
          updateDiceFace(finalDice);
          resolve();
        }, 120);
        return;
      }

      const previewDice = (step % 6) + 1;
      updateDiceFace(previewDice === finalDice ? (previewDice % 6) + 1 : previewDice);
    }, 120);
  });
}

async function rollDice() {
  if (isRolling || els.rollBtn.disabled) return;
  isRolling = true;
  els.rollBtn.disabled = true;

  try {
    const result = await api('/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId })
    });
    await animateDiceTo(result.dice);
    updateDiceFace(result.dice);
    if (result.cell_type === 'trap') {
      showToast(`Ловушка! Выпало ${result.dice}, затем откат на ${result.trap_dice}. Новая клетка: ${result.current_cell}.`);
    } else if (result.cell_type === 'lucky') {
      showToast(`Выпало ${result.dice}. Бонусная клетка ${result.current_cell}: выберите условие.`);
    } else {
      showToast(`Выпало ${result.dice}. Вы перешли на клетку ${result.current_cell}.`);
    }
    await loadState();
  } catch (error) {
    els.rollBtn.classList.remove('rolling');
    showToast(error.message);
    await loadState().catch(() => {});
  } finally {
    isRolling = false;
    render();
  }
}


async function rerollTask() {
  if (isRolling) return;
  els.rerollTaskBtn.disabled = true;
  try {
    const result = await api('/api/reroll-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId })
    });
    showToast(`Штрафной откат на ${result.penalty}. Новая клетка: ${result.current_cell}. Задание сменено.`);
    await loadState();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.rerollTaskBtn.disabled = false;
  }
}

async function chooseLuckyTask(choice) {
  els.luckyChoice.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    await api('/api/lucky-choice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: tgId, choice })
    });
    showToast('Бонусное условие выбрано. Загрузите Фото ДО.');
    await loadState();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.luckyChoice.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}


async function resizeImageTo720p(file) {
  if (!file?.type?.startsWith('image/')) return file;
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      img.src = imageUrl;
    });
    const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = maxSide > 1280 ? 1280 / maxSide : 1;
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Не удалось сжать изображение');
    const baseName = String(file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}-720p.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function submitWork(event) {
  event.preventDefault();
  if (!els.workImage.files[0]) return showToast('Выберите картинку для отправки');

  const fieldName = els.workImage.dataset.fieldName || els.workImage.name || 'photo_before';
  const formData = new FormData();
  formData.append('tg_id', tgId);
  try {
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = 'Сжимаем фото...';
    const optimizedFile = await resizeImageTo720p(els.workImage.files[0]);
    formData.append(fieldName, optimizedFile);
    els.submitBtn.textContent = 'Отправляем...';
    const result = await api('/api/submit', { method: 'POST', body: formData });
    els.workImage.value = '';
    showToast(result.uploaded_stage === 'before' ? 'Фото ДО сохранено. Переходите к раскрашиванию.' : 'Фото ПОСЛЕ отправлено на проверку.');
    await loadState();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = 'Отправить фото';
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
      <strong>🏆 Место №${escapeHtml(winner.place_number)} — Красочка номер ${escapeHtml(winner.ticket_number)}, игрок ${escapeHtml(formatWinnerName(winner))}</strong>
      <span class="muted">${escapeHtml(new Date(winner.drawn_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</span>
    `;
    els.winnersList.append(item);
  }
}

function cardResultMarkup(ticket) {
  if (ticket.status === 'winner') {
    const place = ticket.place_number ? `Место №${escapeHtml(ticket.place_number)}` : 'МОНЕТКА!';
    return `<div><div class="coin">🪙</div><p>${place}</p></div>`;
  }
  if (ticket.status === 'scratched') return '<div>😢<p>Пусто</p></div>';
  return '<div><div class="coin">?</div><p>Что внутри?</p></div>';
}

function renderScratchCards(tickets = [], raffleActive = false) {
  if (!tickets.length) {
    els.scratchGrid.innerHTML = '<div class="empty-state">У вас пока нет Красочек.</div>';
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
      <canvas aria-label="Защитный слой Красочки №${escapeHtml(ticket.ticket_number)}"></canvas>
      <div class="scratch-label">Красочка №${escapeHtml(ticket.ticket_number)}${ticket.type === 'bonus' ? '★' : ''}</div>
    `;
    els.scratchGrid.append(card);
    if (!revealed && raffleActive) setupScratchCanvas(card, ticket);
    if (!raffleActive && !revealed) card.querySelector('.scratch-label').textContent = 'Ждем старта Красочек';
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
    const [coverStart, coverEnd] = rainbowCovers[Math.floor(Math.random() * rainbowCovers.length)];
    const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    gradient.addColorStop(0, coverStart);
    gradient.addColorStop(.5, coverEnd);
    gradient.addColorStop(1, coverStart);
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
    ctx.arc(x, y, Math.max(12, rect.width * .06), 0, Math.PI * 2);
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
        const place = data.winner?.place_number || '';
        prize.innerHTML = `<div><div class="coin">🪙</div><p>${place ? `Место №${escapeHtml(place)}` : 'МОНЕТКА!'}</p></div>`;
        showToast(place ? `🏆 Место №${place} — Красочка номер ${ticket.ticket_number}` : '🎉 Вы нашли монетку и выиграли приз!', 5200);
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
  if (!force) {
    renderWinners(data.results || []);
    const latest = data.latest_winner || null;
    if (latest && latest.id !== lastRaffleWinnerId) {
      lastRaffleWinnerId = latest.id;
      if (animateNew) launchConfetti();
    }
    return;
  }

  els.totalTickets.textContent = data.total_tickets || 0;
  els.activeTickets.textContent = data.active_tickets || 0;
  els.remainingPrizes.textContent = data.remaining_prizes || 0;
  renderWinners(data.results || []);

  els.raffleCountdown.classList.toggle('hidden', !data.is_before_start);
  if (data.is_before_start) updateCountdown(data.config);
  else window.clearInterval(countdownTimer);

  if (!data.is_configured) {
    els.winnerReveal.textContent = 'Красочки еще не настроены администратором.';
  } else if (data.is_before_start) {
    els.winnerReveal.textContent = 'Подготовьте Красочки — скоро можно будет стирать!';
  } else if (data.is_sold_out) {
    els.winnerReveal.textContent = 'Лотерея завершена, все призы разыграны.';
  } else if (data.is_active) {
    els.winnerReveal.textContent = 'Стирайте Красочки и ищите золотую монетку.';
  } else {
    els.winnerReveal.textContent = 'Окно Красочек закрыто.';
  }

  if (force) renderScratchCards(state?.tickets || [], Boolean(data.is_active && !data.is_sold_out));

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
    if (activeTab === 'raffle') loadRaffle(false, true).catch((error) => console.warn('Raffle polling error:', error.message));
  }, 3000);
}

function stopRafflePolling() {
  if (!rafflePollingTimer) return;
  window.clearInterval(rafflePollingTimer);
  rafflePollingTimer = null;
}

async function loadAdminPanel() {
  const adminParam = `admin_tg_id=${encodeURIComponent(tgId)}`;
  if (!hasAdminAccess(state?.user)) return;
  const [pendingUsers, users, exportData, ticketData, raffleConfig, taskData] = await Promise.all([
    api(`/api/admin/pending-users?${adminParam}`),
    api(`/api/admin/users?${adminParam}`),
    api(`/api/admin/tickets-export?${adminParam}`),
    api(`/api/admin/tickets?${adminParam}`),
    api(`/api/admin/raffle-config?${adminParam}`),
    api(`/api/admin/tasks?${adminParam}`)
  ]);
  renderPendingUsers(pendingUsers.users);
  renderAllUsers(users.users);
  renderTicketRegistry(ticketData.tickets || []);
  renderAdminTasks(taskData.tasks || []);
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
  els.pendingSubmissions.innerHTML = '';
  const root = document.createElement('article');
  root.className = 'item archive-accordion open';
  root.innerHTML = '<button type="button" class="archive-toggle"><strong>⏳ Ожидают одобрения</strong></button><div class="archive-panel"><div class="archive-inner pending-submissions-inner"></div></div>';
  const pendingInner = root.querySelector('.pending-submissions-inner');
  if (!submissions.length) pendingInner.innerHTML = '<p class="muted">Все работы проверены!</p>';
  els.pendingSubmissions.append(root);
  for (const submission of submissions) {
    const beforeUrl = `/uploads/${encodeURIComponent(submission.photo_before)}`;
    const afterUrl = `/uploads/${encodeURIComponent(submission.photo_after)}`;
    const playerName = submission.username || submission.tg_id;
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `
      <strong>${escapeHtml(playerName)} — клетка ${submission.cell}</strong>
      <p>${escapeHtml(submission.text_task)}</p>
      <div class="comparison-grid">
        <a class="comparison-photo" href="${beforeUrl}" target="_blank" rel="noopener">
          <strong>Фото ДО</strong>
          <img src="${beforeUrl}" alt="Фото ДО игрока ${escapeHtml(playerName)}">
        </a>
        <a class="comparison-photo" href="${afterUrl}" target="_blank" rel="noopener">
          <strong>Фото ПОСЛЕ</strong>
          <img src="${afterUrl}" alt="Фото ПОСЛЕ игрока ${escapeHtml(playerName)}">
        </a>
      </div>
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
      await renderWorkArchive();
      await loadNews().catch(() => {});
      if (submission.tg_id === tgId) await loadState();
    });

    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger';
    reject.textContent = 'Отклонить';
    reject.addEventListener('click', async () => {
      const comment = item.querySelector(`[data-comment="${submission.id}"]`).value.trim();
      if (!comment) return showToast('Добавьте комментарий для игрока');
      await api('/api/admin/reject-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, submission_id: submission.id, admin_comment: comment })
      });
      showToast('Работа отклонена');
      await renderWorkArchive();
    });

    actions.append(approve, reject);
    item.append(actions);
    pendingInner.append(item);
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

    const roleToggle = document.createElement('button');
    roleToggle.type = 'button';
    roleToggle.className = user.role === 'moderator' ? 'ghost' : 'success';
    roleToggle.textContent = user.role === 'moderator' ? '👤 Забрать права модератора' : '👑 Выдать права модератора';
    roleToggle.disabled = user.role === 'admin' || user.tg_id === OWNER_TG_ID;
    roleToggle.addEventListener('click', async () => {
      await toggleModerator(user.tg_id, user.role);
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

    tools.append(changeCell, resetDice, roleToggle, remove);
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

function renderAdminTasks(tasks = []) {
  els.taskAdminList.innerHTML = tasks.length ? '' : '<p class="muted">Заданий пока нет.</p>';
  for (const task of tasks) {
    const item = document.createElement('article');
    item.className = 'item task-row';
    item.innerHTML = `<p>${escapeHtml(task.text_task)}</p>`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Удалить это задание?')) return;
      await api('/api/admin/remove-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_tg_id: tgId, task_id: task.id })
      });
      showToast('Задание удалено');
      await loadAdminPanel();
    });

    item.append(remove);
    els.taskAdminList.append(item);
  }
}

async function addAdminTask(event) {
  event.preventDefault();
  const textTask = els.taskAdminText.value.trim();
  if (!textTask) return showToast('Введите текст задания');
  await api('/api/admin/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId, text_task: textTask })
  });
  els.taskAdminText.value = '';
  showToast('Задание добавлено');
  await loadAdminPanel();
}

async function toggleModerator(targetTgId, targetRole) {
  const actionText = targetRole === 'moderator' ? 'забрать права модератора' : 'выдать права модератора';
  if (!window.confirm(`Точно ${actionText} для ID ${targetTgId}?`)) return;
  const result = await api('/api/admin/toggle-moderator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId, target_tg_id: targetTgId })
  });
  showToast(result.user.role === 'moderator' ? 'Права модератора выданы' : 'Права модератора забраны');
  await loadAdminPanel();
  if (targetTgId === tgId) await loadState();
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
  showToast('Настройки сохранены');
  await loadRaffle(true).catch(() => {});
}

async function resetRound() {
  if (!window.confirm('Точно-точно сбросить раунд?')) return;
  await api('/api/admin/reset-round', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_tg_id: tgId })
  });
  showToast('Раунд мягко сброшен');
  raffleLoadedAt = 0;
  scratchers.clear();
  await loadState();
  await loadLeaderboard().catch(() => {});
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
els.rerollTaskBtn.addEventListener('click', () => rerollTask().catch((error) => showToast(error.message)));
els.luckyChoice.addEventListener('click', (event) => {
  const button = event.target.closest('[data-lucky-choice]');
  if (button) chooseLuckyTask(button.dataset.luckyChoice).catch((error) => showToast(error.message));
});
els.submitForm.addEventListener('submit', submitWork);
els.taskAdminForm.addEventListener('submit', (event) => addAdminTask(event).catch((error) => showToast(error.message)));
els.grantTicketForm.addEventListener('submit', (event) => grantTicket(event).catch((error) => showToast(error.message)));
els.raffleConfigForm.addEventListener('submit', (event) => saveRaffleConfig(event).catch((error) => showToast(error.message)));
els.refreshExportBtn.addEventListener('click', () => refreshExport().catch((error) => showToast(error.message)));
els.resetRoundBtn?.addEventListener('click', () => resetRound().catch((error) => showToast(error.message)));
els.globalResetBtn.addEventListener('click', () => globalReset().catch((error) => showToast(error.message)));
els.leaderboardTable?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-react]');
  if (!button) return;
  sendReaction(button.dataset.toId, button.dataset.react, button);
});

function toggleArchiveAccordion(event) {
  const button = event.target.closest('.archive-toggle');
  if (!button) return;
  const section = button.closest('.archive-accordion');
  section?.classList.toggle('open');
}

els.paletteGrid.addEventListener('click', toggleArchiveAccordion);
els.pendingSubmissions.addEventListener('click', toggleArchiveAccordion);

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
