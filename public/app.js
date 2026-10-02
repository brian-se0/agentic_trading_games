/* Agentic Trading Games — student app */

let sessionActive = false;
let csrfToken = null;
let snapshot = null;
let snapshotRevision = null;
let stream = null;
let everConnected = false;
let currentScreen = '';
let tradeTimer = null;
let tradeSeconds = 0;
let restoreTimer = null;
let actionCounter = 0;
let actionInFlight = false;
let actionRequestGeneration = 0;
let identityGeneration = 0;
let restoreInFlight = null;
let restoreInFlightIdentity = null;
let restoreGeneration = 0;
let formStateOwner = null;
let studentConfirmReturnFocus = null;
let tradingDomOwner = null;
let tradingDomLayout = null;
const tradingControlBindings = new WeakSet();

/* form state that must survive re-renders */
const orderForm = { side: 'buy', type: 'limit', price: null, qty: 1 };
const bidForm = { qty: 1, face: 2, key: null };

function resetFormState() {
  Object.assign(orderForm, { side: 'buy', type: 'limit', price: null, qty: 1 });
  Object.assign(bidForm, { qty: 1, face: 2, key: null });
}

function syncFormStateOwner() {
  const owner = sessionActive && snapshot
    ? `${snapshot.participant?.id ?? ''}:${snapshot.session?.id ?? ''}:${snapshot.room?.id ?? ''}`
    : null;
  if (owner !== formStateOwner) {
    resetFormState();
    formStateOwner = owner;
  }
}

const BOT_NAMES = ['Nash', 'Selten', 'Vickrey', 'Arrow', 'Harsanyi', 'Aumann', 'Shapley', 'Myerson', 'Schelling', 'Borel', 'Zermelo', 'Rubinstein', 'Osborne', 'Binmore', 'Gale'];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

function setMarkup(element, html) {
  element.innerHTML = html;
}

function percentClass(value) {
  return `atg-pct-${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}`;
}

function snapshotHasLiveActivity(value = snapshot) {
  return Boolean(value) && !['completed', 'voided', 'archived'].includes(value.session?.state) &&
    !['completed', 'voided'].includes(value.room?.status);
}

function stableStudentFocusSelector(element) {
  const id = String(element?.id ?? '').replace(/^#/, '');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  if (element?.classList?.contains('switch-student')) return '.switch-student';
  const dataAttributes = [
    ['choice', 'data-choice'],
    ['face', 'data-face'],
    ['bj', 'data-bj'],
    ['poker', 'data-poker'],
    ['orderId', 'data-order-id'],
  ];
  for (const [property, attribute] of dataAttributes) {
    if (element?.dataset?.[property] != null) return `[${attribute}="${element.dataset[property]}"]`;
  }
  return null;
}

function restoreStudentFocus(selector) {
  if (!selector) return;
  requestAnimationFrame(() => {
    if ($('#student-confirm-dialog')?.open) return;
    const target = $(selector);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  });
}

function trapDialogTab(dialog, event) {
  if (event.key !== 'Tab' || !dialog.open) return;
  const surface = dialog.querySelector('[data-dialog-surface]');
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((element) => {
    if (element.closest?.('[hidden]')) return false;
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
  });
  if (!focusable.length) {
    event.preventDefault();
    surface?.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  const wraps = event.shiftKey
    ? active === first || !focusable.includes(active)
    : active === last || !focusable.includes(active);
  if (!wraps) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus({ preventScroll: true });
}

function acceptSnapshot(candidate) {
  if (!candidate) return false;
  const revision = Number.isSafeInteger(candidate.revision) ? candidate.revision : null;
  if (revision != null && snapshotRevision != null && revision < snapshotRevision) return false;
  snapshot = candidate;
  if (revision != null) snapshotRevision = revision;
  return true;
}

const FRIENDLY_ERRORS = [
  [/invalid join code/i, "That code didn't match. Double-check it with your professor."],
  [/roster is not open/i, 'This game already started — ask your professor to open the next one.'],
  [/name is required/i, 'Please enter your first name.'],
  [/capacity reached/i, 'The room is full — let your professor know.'],
  [/not your turn/i, "Hold on — it's not your turn yet."],
  [/duplicate action/i, 'That move was already counted.'],
  [/stale action|screen has already changed/i, 'That screen just changed. Review the latest game state and try again.'],
  [/session is not running/i, 'The game is paused right now.'],
  [/rate limit/i, "Easy! You're sending orders too fast."],
  [/bid must be higher/i, 'Your bid has to beat the current one.'],
  [/exceeds available cash|capacity/i, "You don't have enough cash or room for that order."],
  [/market is closed/i, "Time's up — the market is closed."],
  [/controlled by a bot/i, 'A bot is filling your seat. Ask your professor to give it back when you are ready.'],
  [/room is unhealthy/i, 'This table hit a snag — your professor is on it.'],
  [/invalid invitation|already used invitation/i, 'That personal invite is invalid or has already been used. Ask your professor for a new one.'],
  [/student session/i, 'You were signed out. Join again with your personal invite.'],
  [/failed to fetch|networkerror/i, "Can't reach the classroom server. Check your wifi."],
];
function friendly(message) {
  for (const [pattern, text] of FRIENDLY_ERRORS) if (pattern.test(message)) return text;
  return message;
}

let toastTimer = null;
function clearToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  const el = $('#toast');
  if (!el) return;
  el.classList.remove('show');
  el.textContent = '';
}

function toast(message) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.textContent = friendly(message);
  el.classList.add('show');
  const timer = setTimeout(() => {
    if (toastTimer !== timer) return;
    toastTimer = null;
    el.classList.remove('show');
    el.textContent = '';
  }, 4000);
  toastTimer = timer;
}

async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = new Error((await response.json().catch(() => ({}))).error ?? `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/* ---------- bounded server-sent events ---------- */
function connect() {
  if (!sessionActive) return;
  if (stream) {
    stream.close();
  }
  const connectionIdentity = identityGeneration;
  const connection = new EventSource('/api/events');
  stream = connection;
  connection.onopen = () => {
    if (stream !== connection || identityGeneration !== connectionIdentity) return;
    everConnected = true;
    setConn(true);
  };
  connection.onerror = () => {
    if (stream !== connection || identityGeneration !== connectionIdentity) return;
    setConn(false);
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => { if (sessionActive) restore(); }, 1500);
  };
  const receive = (event) => {
    if (stream !== connection || identityGeneration !== connectionIdentity) return;
    if (!acceptSnapshot(JSON.parse(event.data))) return;
    render();
    if (!snapshotHasLiveActivity()) {
      connection.close();
      if (stream === connection) stream = null;
    }
  };
  for (const type of ['snapshot', 'room_update', 'session_update', 'health']) connection.addEventListener(type, receive);
}

function setConn(online) {
  const el = $('#conn');
  if (!el) return;
  const compact = el.classList.contains('compact');
  const label = online ? 'Connected' : 'Reconnecting';
  el.setAttribute('aria-label', label);
  el.title = label;
  if (online) {
    el.className = `conn${compact ? ' compact' : ''}`;
    el.innerHTML = `<span class="dot"></span>${compact ? '' : 'Connected'}`;
  } else {
    el.className = `conn reconnecting${compact ? ' compact' : ''}`;
    el.innerHTML = `<span class="dot amber"></span>${compact ? '' : 'Reconnecting…'}`;
  }
}

function abandonRestore() {
  restoreGeneration += 1;
  restoreInFlight = null;
  restoreInFlightIdentity = null;
}

async function restore() {
  const requestedIdentity = identityGeneration;
  if (restoreInFlight && restoreInFlightIdentity === requestedIdentity) return restoreInFlight;
  const generation = ++restoreGeneration;
  const retryButton = $('#retry-restore');
  if (retryButton) {
    retryButton.disabled = true;
    retryButton.textContent = 'Trying…';
  }
  clearTimeout(restoreTimer);
  restoreTimer = null;
  const attempt = (async () => {
    let restoredSnapshot;
    try {
      restoredSnapshot = await api('/api/me');
    } catch (error) {
      if (generation !== restoreGeneration || requestedIdentity !== identityGeneration) return false;
      snapshot = null;
      if (error.status === 401) {
        sessionActive = false;
        csrfToken = null;
        snapshotRevision = null;
        identityGeneration += 1;
        actionRequestGeneration += 1;
        actionInFlight = false;
        if (stream) {
          stream.close();
          stream = null;
        }
        render();
      } else {
        renderReconnect();
        restoreTimer = setTimeout(() => { if (requestedIdentity === identityGeneration) restore(); }, 1500);
      }
      return false;
    }

    if (generation !== restoreGeneration || requestedIdentity !== identityGeneration) return false;
    csrfToken = restoredSnapshot.csrfToken;
    delete restoredSnapshot.csrfToken;
    sessionActive = true;
    acceptSnapshot(restoredSnapshot);
    if (snapshotHasLiveActivity()) connect();
    else if (stream) {
      stream.close();
      stream = null;
    }
    render();
    return true;
  })();

  restoreInFlight = attempt;
  restoreInFlightIdentity = requestedIdentity;
  try {
    return await attempt;
  } finally {
    if (generation === restoreGeneration) {
      restoreInFlight = null;
      restoreInFlightIdentity = null;
    }
  }
}

function nextActionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  actionCounter = (actionCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${actionCounter.toString(36)}-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function signOut(ask = true) {
  if (ask) {
    requestSignOut();
    return;
  }
  clearTimeout(restoreTimer);
  restoreTimer = null;
  abandonRestore();
  identityGeneration += 1;
  actionRequestGeneration += 1;
  actionInFlight = false;
  try {
    if (sessionActive) await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    // The local UI still clears when the server is unreachable; the cookie expires quickly server-side.
  }
  sessionActive = false;
  csrfToken = null;
  snapshot = null;
  snapshotRevision = null;
  resetFormState();
  formStateOwner = null;
  if (stream) {
    stream.close();
    stream = null;
  }
  render();
}

function requestSignOut() {
  if (actionInFlight) {
    toast('Wait for your current move to finish before switching students.');
    return;
  }
  const dialog = $('#student-confirm-dialog');
  if (dialog.open) return;
  studentConfirmReturnFocus = document.activeElement?.classList?.contains('switch-student')
    ? '.switch-student'
    : document.activeElement?.id === 'leave-device' ? '#leave-device'
      : document.activeElement?.id === 'leave-reconnect' ? '#leave-reconnect' : '#screen';
  const finished = currentScreen === 'done';
  $('#student-confirm-title').textContent = finished ? 'Sign out of this device?' : 'Switch students?';
  $('#student-confirm-description').textContent = finished
    ? 'A future activity will require its own one-time personal invitation.'
    : 'Signing out revokes this browser session. Ask your professor for a new personal invitation to return.';
  $('#student-confirm-submit').textContent = finished ? 'Sign out' : 'Switch student';
  dialog.showModal();
  requestAnimationFrame(() => { if (dialog.open) $('#student-confirm-close').focus(); });
}

function closeStudentConfirmation() {
  const dialog = $('#student-confirm-dialog');
  if (!dialog.open) return;
  dialog.close();
  const focusTarget = $(studentConfirmReturnFocus ?? '#screen') ?? $('#screen');
  studentConfirmReturnFocus = null;
  focusTarget?.focus?.({ preventScroll: true });
}

$('#student-confirm-close').addEventListener('click', closeStudentConfirmation);
$('#student-confirm-dialog').addEventListener('keydown', (event) => {
  trapDialogTab($('#student-confirm-dialog'), event);
});
$('#student-confirm-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeStudentConfirmation();
});
$('#student-confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('#student-confirm-dialog').close();
  studentConfirmReturnFocus = null;
  signOut(false);
});

function renderReconnect() {
  mount(`
  <div class="shell atg-u-67b151e80d">
    <span class="brandline">Agentic Trading Games</span>
    <div class="stack atg-u-d56e3e3bc1">
      <h1 class="serif atg-u-c6433c200c">Reconnecting to your class…</h1>
      <p class="muted atg-u-38965f9b18">Keep this page open. We’ll bring your seat back as soon as the classroom server is reachable.</p>
    </div>
    <button class="btn primary block" id="retry-restore">Try again now</button>
    <button class="linkish" id="leave-reconnect">Switch student</button>
  </div>`, 'reconnecting');
  $('#retry-restore').addEventListener('click', restore);
  $('#leave-reconnect').addEventListener('click', requestSignOut);
}

function disableActionControls() {
  $$('[data-choice], #bid-btn, #challenge-btn, [data-bj], [data-poker], #submit-order, .cancel-order, .switch-student, #leave-device')
    .forEach((button) => { button.disabled = true; });
}

function tradingActionFeedback(result) {
  if (result?.type === 'order_cancelled') return `Order cancelled. ${result.cancelledQuantity} unit${result.cancelledQuantity === 1 ? '' : 's'} released.`;
  if (result?.type !== 'order_accepted') return '';
  if (result.cancelledQuantity > 0 && result.filledQuantity === 0) return 'No matching order was available, so nothing filled.';
  if (result.cancelledQuantity > 0) return `${result.filledQuantity} filled; ${result.cancelledQuantity} unmatched unit${result.cancelledQuantity === 1 ? '' : 's'} cancelled.`;
  if (result.restingQuantity > 0 && result.filledQuantity > 0) return `${result.filledQuantity} filled; ${result.restingQuantity} unit${result.restingQuantity === 1 ? '' : 's'} added to the order book.`;
  if (result.restingQuantity > 0) return `Order placed: ${result.restingQuantity} unit${result.restingQuantity === 1 ? '' : 's'} now working.`;
  return `${result.filledQuantity} unit${result.filledQuantity === 1 ? '' : 's'} filled.`;
}

async function act(action) {
  if (actionInFlight) return false;
  actionInFlight = true;
  const requestGeneration = ++actionRequestGeneration;
  const requestIdentity = identityGeneration;
  const requestSession = sessionActive;
  const stillCurrent = () => requestGeneration === actionRequestGeneration &&
    requestIdentity === identityGeneration && requestSession === sessionActive;
  disableActionControls();
  let errorMessage = '';
  let feedback = '';
  try {
    const response = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ actionId: nextActionId(), actionEpoch: snapshot?.actionEpoch ?? 0, action })
    });
    if (!stillCurrent()) return false;
    const { actionResult, ...nextSnapshot } = response;
    acceptSnapshot(nextSnapshot);
    feedback = tradingActionFeedback(actionResult);
  } catch (error) {
    if (!stillCurrent()) return false;
    errorMessage = error.message;
  }
  if (!stillCurrent()) return false;
  actionInFlight = false;
  render();
  if (errorMessage) toast(errorMessage);
  else if (feedback) toast(feedback);
  else clearToast();
  return !errorMessage;
}

/* ---------- shared helpers ---------- */
function me() { return snapshot.participant.id; }

function playerName(state, player) {
  if (!player) return '—';
  if (player.id === me()) return 'You';
  if (!player.isBot) return player.name;
  const botIndex = state.players.filter((p) => p.isBot).findIndex((p) => p.id === player.id);
  return BOT_NAMES[botIndex % BOT_NAMES.length];
}
function nameById(state, id) { return playerName(state, state.players.find((p) => p.id === id)); }
function nameTag(state, player) {
  return `${esc(playerName(state, player))}${player.isBot && player.id !== me() ? ' <span class="tag-bot">BOT</span>' : ''}`;
}
function firstName() { return esc(String(snapshot.participant.name).split(' ')[0]); }

const PIPS = {
  1: [[50, 50]], 2: [[28, 28], [72, 72]], 3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]], 5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 28], [72, 28], [28, 50], [72, 50], [28, 72], [72, 72]],
};
function dieHtml(face, { small = false, wild = face === 1 } = {}) {
  const pips = (PIPS[face] ?? []).map(([x, y]) => `<span class="pip pip-x-${x} pip-y-${y}"></span>`).join('');
  return `<span class="die${small ? ' small' : ''}${wild ? ' wild' : ''}" role="img" aria-label="Die showing ${face}${wild ? ', wild' : ''}">${pips}${wild ? '<span class="star">★</span>' : ''}</span>`;
}

const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
function pcardHtml(card) {
  if (!card || card.hidden) return '<span class="pcard back"></span>';
  const red = card.suit === 'H' || card.suit === 'D';
  return `<span class="pcard${red ? ' red' : ''}"><span class="rank">${esc(card.rank)}</span><span class="suit">${SUITS[card.suit] ?? ''}</span></span>`;
}

function mount(html, key) {
  currentScreen = key;
  if (key !== 'trading') {
    tradingDomOwner = null;
    tradingDomLayout = null;
  }
  setMarkup($('#screen'), html);
  $('.switch-student')?.addEventListener('click', () => signOut());
  if (actionInFlight) disableActionControls();
}

function connectionControls(switchable = false) {
  return `<span class="row atg-u-ebac58e0be">
    ${switchable ? '<button class="linkish switch-student atg-u-e83364556c" aria-label="Switch student" title="Switch student">Switch</button>' : ''}
    <span id="conn" class="conn${switchable ? ' compact' : ''}" role="status" aria-live="polite" aria-atomic="true" aria-label="Connected" title="Connected"><span class="dot"></span>${switchable ? '' : 'Connected'}</span>
  </span>`;
}

function brandHeader(right = connectionControls()) {
  return `<header class="screen-header atg-u-9be42e4722">
    <span class="brandline">Agentic Trading Games</span>
    ${right}
  </header>`;
}

function gameHeader(title, pill, progress = null) {
  return `<header class="screen-header atg-u-e53982496b">
    <div class="row between">
      <span class="title">${title}</span>
      <span class="row atg-u-d56e3e3bc1">
        <span class="pill">${pill}</span>
        ${connectionControls(true)}
      </span>
    </div>
    ${progress == null ? '' : `<div class="progress-track"><div class="progress-fill ${percentClass(progress * 100)}"></div></div>`}
  </header>`;
}

function pausedBanner() {
  const state = snapshot.session?.state;
  if (state === 'paused' || state === 'pausing') {
    return '<div class="notice-banner" role="status" aria-live="polite"><span class="dot amber"></span>Your professor paused the game. Sit tight.</div>';
  }
  if (snapshot.room?.seatControlledByBot) {
    return '<div class="notice-banner" role="status" aria-live="polite"><span class="dot amber"></span>A bot is filling your seat. Ask your professor to give it back when you are ready.</div>';
  }
  if (snapshot.room?.unhealthy) {
    return '<div class="notice-banner" role="status" aria-live="polite"><span class="dot amber"></span>This table hit a snag — your professor is on it.</div>';
  }
  return '';
}

function waitingLine(text) {
  return `<div class="card atg-u-ee4a910191" role="status" aria-live="polite">${text}</div>`;
}

/* ---------- screens ---------- */
function render() {
  const focusSelector = $('#student-confirm-dialog')?.open ? null : stableStudentFocusSelector(document.activeElement);
  try {
    clearInterval(tradeTimer);
    tradeTimer = null;

    if (!sessionActive || !snapshot) {
      syncFormStateOwner();
      renderJoin();
      return;
    }
    syncFormStateOwner();
    const session = snapshot.session;
    const room = snapshot.room;

    if (!session) { renderLobby('Your class session ended.'); return; }
    if (session.state === 'voiding') { renderCancelling(); return; }
    if (session.state === 'voided') { renderDone(true); return; }
    if (room?.status === 'voided') { renderDone(true); return; }
    if (room && (room.status === 'completed' || room.state.status === 'completed' || session.state === 'completed')) { renderDone(false); return; }
    if (!room) {
      if (session.state === 'lobby') renderLobby();
      else renderLobby('Waiting for your seat…');
      return;
    }
    const renderers = { rps: renderRps, liars_dice: renderLiars, blackjack: renderBlackjack, poker: renderPoker, trading: renderTrading };
    (renderers[room.state.game] ?? (() => renderLobby()))(room.state);
  } finally {
    restoreStudentFocus(focusSelector);
  }
}

/* ----- join ----- */
function renderJoin() {
  mount(`
  <div class="shell atg-u-c0d09338c8">
    <header class="atg-u-26820f37d7">
      <span class="brandline">Agentic Trading Games</span>
    </header>
    <div class="atg-u-31d2391cd6">
      <div class="stack atg-u-d56e3e3bc1">
        <h1 class="serif atg-u-a0ffee6ad2">Join your class</h1>
        <p class="muted atg-u-38965f9b18">Enter the class code and your one-time personal invite.</p>
      </div>
      <form id="join-form" class="stack atg-u-e9974ce1e4">
        <label class="field">
          <span>Class code</span>
          <input id="join-code" class="input code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="000000" required>
        </label>
        <label class="field">
          <span>Personal invite</span>
          <input id="invite-code" class="input code" maxlength="100" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" placeholder="invite_…" required>
        </label>
        <div class="stack atg-u-9bee47f62a">
          <button type="submit" class="btn primary block atg-u-5301de45e8">Join session</button>
          <p class="faint atg-u-2b1321d9fa">Each personal invite works once and only for its assigned student.</p>
        </div>
      </form>
    </div>
  </div>`, 'join');

  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#join-form button');
    button.disabled = true;
    button.textContent = 'Joining…';
    try {
      const result = await api('/api/join', {
        method: 'POST',
        body: JSON.stringify({
          joinCode: $('#join-code').value.trim(),
          inviteCode: $('#invite-code').value.trim(),
        }),
      });
      clearToast();
      abandonRestore();
      identityGeneration += 1;
      actionRequestGeneration += 1;
      actionInFlight = false;
      sessionActive = true;
      csrfToken = result.csrfToken;
      snapshot = null;
      snapshotRevision = null;
      await restore();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Join session';
      toast(error.message);
    }
  });
  $('#join-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  });
}

/* ----- lobby ----- */
const GAME_FACTS = {
  rps: ['Head-to-head', 'quick rounds'],
  liars_dice: ['Bluffing with dice', 'ones are wild'],
  blackjack: ['Against the dealer', 'fixed 10-unit bets'],
  poker: ['One card each', 'simple betting'],
  trading: ['A live market', 'buy low, sell high'],
};
function renderLobby(note = '') {
  const session = snapshot.session;
  const rounds = session?.config?.rounds;
  const duration = session?.config?.duration;
  const modeLabel = { random: 'Practice bots', strategy: 'Adaptive bots', live: 'Your classmates' }[session?.mode] ?? '—';
  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${brandHeader(connectionControls(true))}
    <div class="atg-u-de39d59083">
      <div class="atg-u-51c76e18c2">
        <span class="dot atg-u-aab07b60e2"></span>
      </div>
      <div class="stack atg-u-d56e3e3bc1">
        <h1 class="serif atg-u-24d6aa3b20">You're in, ${firstName()}!</h1>
        <p class="muted atg-u-38965f9b18">${note || 'Your professor will start the game for everyone at once.'}</p>
      </div>
      ${session ? `
      <div class="card stack atg-u-106c81ce8c">
        <span class="kicker">Today's activity</span>
        <span class="serif atg-u-25e8d42e56">${esc(shortGameName(session.game))}</span>
        <div class="stack atg-u-42157081b0">
          <div class="row between"><span class="faint">Playing with</span><b>${modeLabel}</b></div>
          ${rounds ? `<div class="row between"><span class="faint">Rounds</span><b class="mono">${rounds}</b></div>` : ''}
          ${duration ? `<div class="row between"><span class="faint">Market open for</span><b class="mono">${fmtClock(duration)}</b></div>` : ''}
          ${GAME_FACTS[session.game] ? `<div class="row between"><span class="faint">The gist</span><b>${GAME_FACTS[session.game][0]}</b></div>` : ''}
        </div>
      </div>` : ''}
      <p class="faint atg-u-2b1321d9fa">Keep this tab open — the game starts here.</p>
    </div>
  </div>`, 'lobby');
  setConn(stream?.readyState === 1);
}

function shortGameName(game) {
  return { rps: 'Rock Paper Scissors', liars_dice: "Liar's Dice", blackjack: 'Blackjack', poker: 'Leduc Poker', trading: 'Open Market' }[game] ?? game;
}
function fmtClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ----- rock paper scissors ----- */
const RPS_ICONS = {
  rock: '<span class="atg-u-dc59ee8c41"></span>',
  paper: '<span class="atg-u-92f240370b"></span>',
  scissors: '<span class="atg-u-ce221a14ec">✕</span>',
};
function renderRps(state) {
  const opponent = state.players.find((p) => p.id !== me());
  const canPlay = state.legalActions.length > 0;
  const wins = state.scores[me()] ?? 0;
  const losses = state.scores[opponent.id] ?? 0;
  const resolved = state.status === 'completed' ? state.totalRounds : state.round - 1;
  const draws = Math.max(0, resolved - wins - losses);
  const last = state.history[state.history.length - 1];
  const squares = state.history.map((row) => {
    const cls = !row.winner ? '' : row.winner === me() ? 'w' : 'l';
    return `<span class="result-sq ${cls}"></span>`;
  }).join('');

  let lastLine = '';
  if (last) {
    const mineChoice = last.choices[me()];
    const theirs = last.choices[opponent.id];
    const outcome = !last.winner ? 'a draw' : last.winner === me() ? '<b class="atg-u-5516851989">you won</b>' : '<b class="atg-u-316c369cf5">you lost</b>';
    lastLine = `<div class="event-banner">Round ${last.round}: you played <b>${mineChoice}</b>, ${esc(playerName(state, opponent))} played <b>${theirs}</b> — ${outcome}.</div>`;
  }

  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${gameHeader('Rock · Paper · Scissors', `Round ${Math.min(state.round, state.totalRounds)} / ${state.totalRounds}`, (state.round - 1) / state.totalRounds)}
    ${pausedBanner()}
    ${lastLine}
    <div class="card atg-u-b8b35e52db">
      <div class="stack atg-u-8d9dae33c5">
        <span class="mono atg-u-923758b22d">${wins}</span>
        <span class="atg-u-6a7e1199b8">You</span>
      </div>
      <span class="serif atg-u-bdf1192f21">vs</span>
      <div class="stack atg-u-8d9dae33c5">
        <span class="mono atg-u-ac9042e9f2">${losses}</span>
        <span class="atg-u-6a7e1199b8">${nameTag(state, opponent)}</span>
      </div>
    </div>
    <div class="stack atg-u-2a77e35063">
      <div class="atg-u-8812e8ddf6">${canPlay ? 'Make your move' : state.youSubmitted ? `Locked in — waiting for ${esc(playerName(state, opponent))}…` : 'Waiting…'}</div>
      <div class="atg-u-5260e05489">
        ${['rock', 'paper', 'scissors'].map((choice) => `
          <button class="btn atg-u-22e4845d36" data-choice="${choice}" ${canPlay ? '' : 'disabled'}
           >
            ${RPS_ICONS[choice]}
            <span class="atg-u-cdcef186c8">${choice[0].toUpperCase()}${choice.slice(1)}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="stack atg-u-cfa07c18e7">
      <div class="row between">
        <span class="kicker">Your last rounds</span>
        <span class="mono atg-u-bb625bb7d8">${wins}W · ${losses}L · ${draws}D</span>
      </div>
      <div class="row wrap atg-u-c1e85f68fc">${squares || '<span class="faint atg-u-c42f23b8ec">First round coming up.</span>'}</div>
      ${squares ? '<div class="faint atg-u-c42f23b8ec">Newest on the right · green won, red lost, gray drew</div>' : ''}
    </div>
  </div>`, 'game');
  setConn(stream?.readyState === 1);
  $$('[data-choice]').forEach((button) => button.addEventListener('click', () => act({ type: 'play', choice: button.dataset.choice })));
}

/* ----- liar's dice ----- */
function renderLiars(state) {
  const bidAction = state.legalActions.find((a) => a.type === 'bid');
  const canChallenge = state.legalActions.some((a) => a.type === 'challenge');
  const myTurn = state.currentPlayer === me() && state.legalActions.length > 0;
  const totalDice = state.players.length * 5;

  const key = `${state.round}:${state.currentBid?.quantity ?? 0}:${state.currentBid?.face ?? 0}`;
  if (bidForm.key !== key) {
    bidForm.key = key;
    if (!state.currentBid) { bidForm.qty = 2; bidForm.face = 2; }
    else if (state.currentBid.face < 6) { bidForm.qty = state.currentBid.quantity; bidForm.face = state.currentBid.face + 1; }
    else { bidForm.qty = Math.min(totalDice, state.currentBid.quantity + 1); bidForm.face = 2; }
  }
  const higher = !state.currentBid || bidForm.qty > state.currentBid.quantity ||
    (bidForm.qty === state.currentBid.quantity && bidForm.face > state.currentBid.face);

  const chips = state.players.map((player) => {
    const current = state.currentPlayer === player.id && state.status !== 'completed';
    const scoreValue = state.scores[player.id] ?? 0;
    return `<div class="dice-player ${current ? 'current' : ''}">
      <span class="dice-player-name ${player.id === me() ? 'you' : ''}">${esc(playerName(state, player))}</span>
      <span class="mono dice-player-score ${player.id === me() ? 'you' : ''}">${scoreValue > 0 ? '+' : ''}${scoreValue}</span>
      <span class="dice-player-state ${current ? 'current' : player.isBot ? 'bot' : 'idle'}">${current ? (player.id === me() ? 'your turn' : 'thinking…') : player.isBot ? 'BOT' : '·'}</span>
    </div>`;
  }).join('');

  const last = state.history[state.history.length - 1];
  let lastLine = '';
  if (last) {
    lastLine = `<div class="event-banner">Round ${last.round}: <b>${esc(nameById(state, last.challenger))}</b> challenged <b>${esc(nameById(state, last.bidder))}</b>'s ${last.bid.quantity} × ${last.bid.face}s — there were <b>${last.actual}</b>. <b>${esc(nameById(state, last.winner))}</b> +1, ${esc(nameById(state, last.loser))} −1.</div>`;
  }

  const prob = state.probabilityCurrentBidTrue;
  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${gameHeader("Liar's Dice", `Round ${Math.min(state.round, state.totalRounds)} / ${state.totalRounds}`, (state.round - 1) / state.totalRounds)}
    ${pausedBanner()}
    <div class="row atg-u-e9e385ad1c">${chips}</div>
    ${lastLine}
    <div class="stack atg-u-b76780ce47">
      <span class="kicker">Your dice · only you see these</span>
      <div class="row atg-u-0c4195fd8e">${state.yourDice.map((die) => dieHtml(die)).join('')}</div>
      <span class="faint atg-u-c42f23b8ec">Ones are wild — they count toward any face.</span>
    </div>
    <div class="card stack atg-u-b76780ce47">
      <span class="kicker">Current bid</span>
      ${state.currentBid ? `
        <div class="row atg-u-b83dc11784">
          <span class="mono atg-u-4139c9d292">${state.currentBid.quantity} ×</span>
          ${dieHtml(state.currentBid.face, { small: true, wild: false })}
          <span class="muted atg-u-b4d52c7c65">at least ${state.currentBid.quantity} ${state.currentBid.face}s<br>on the table</span>
        </div>
        ${prob == null ? '' : `
        <div class="stack atg-u-b0dfcce953">
          <div class="row between atg-u-e269f80a7a"><span>Chance the bid is true, given your dice</span><b class="mono atg-u-61ba8a4b16">${Math.round(prob * 100)}%</b></div>
          <div class="bid-probability"><div class="bid-probability-fill ${percentClass(prob * 100)}"></div></div>
        </div>`}
      ` : '<span class="muted atg-u-905228b6d5">No bids yet — you open the round.</span>'}
    </div>
    <div class="stack atg-u-c781a67484">
    ${myTurn ? `
      <div class="row atg-u-69e6a52348">
        <div class="field atg-u-6253876a64">
          <span>Quantity</span>
          <div class="stepper atg-u-bcf03b01d5">
            <button type="button" id="qty-down" aria-label="Decrease bid quantity" ${bidForm.qty <= 1 ? 'disabled' : ''}>−</button>
            <span class="val"><b>${bidForm.qty}</b></span>
            <button type="button" id="qty-up" aria-label="Increase bid quantity" ${bidForm.qty >= totalDice ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <div class="field atg-u-9919078516">
          <span>Face</span>
          <div class="row atg-u-da7a6f8767">
            ${[2, 3, 4, 5, 6].map((f) => `<button type="button" class="btn face-pick ${f === bidForm.face ? 'selected' : ''}" data-face="${f}" aria-pressed="${f === bidForm.face}">${f}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="row atg-u-84dfe8ad07">
        <button class="btn primary atg-u-c4a45da00b" id="bid-btn" ${bidAction && higher ? '' : 'disabled'}>Bid ${bidForm.qty} × ${bidForm.face}s</button>
        <button class="btn danger atg-u-6253876a64" id="challenge-btn" ${canChallenge ? '' : 'disabled'}>Challenge!</button>
      </div>
      ${!higher && bidAction ? '<span class="faint atg-u-306e473278">Your bid has to beat the current one — raise the quantity or the face.</span>' : ''}
    ` : waitingLine(`Waiting for <b>${esc(nameById(state, state.currentPlayer))}</b> to move…`)}
    </div>
  </div>`, 'game');
  setConn(stream?.readyState === 1);

  if (myTurn) {
    $('#qty-down')?.addEventListener('click', () => {
      bidForm.qty = Math.max(1, bidForm.qty - 1);
      render();
      requestAnimationFrame(() => (bidForm.qty <= 1 ? $('#qty-up') : $('#qty-down'))?.focus());
    });
    $('#qty-up')?.addEventListener('click', () => {
      bidForm.qty = Math.min(totalDice, bidForm.qty + 1);
      render();
      requestAnimationFrame(() => (bidForm.qty >= totalDice ? $('#qty-down') : $('#qty-up'))?.focus());
    });
    $$('.face-pick').forEach((button) => button.addEventListener('click', () => {
      bidForm.face = Number(button.dataset.face);
      render();
      requestAnimationFrame(() => $(`[data-face="${bidForm.face}"]`)?.focus());
    }));
    $('#bid-btn')?.addEventListener('click', () => act({ type: 'bid', quantity: bidForm.qty, face: bidForm.face }));
    $('#challenge-btn')?.addEventListener('click', () => act({ type: 'challenge' }));
  }
}

/* ----- blackjack ----- */
function renderBlackjack(state) {
  const myHands = state.hands[me()] ?? [];
  const myTurn = state.currentPlayer === me() && state.legalActions.length > 0;
  const legal = new Set(state.legalActions.map((a) => a.type));
  const others = state.players.filter((p) => p.id !== me());

  const last = state.history[state.history.length - 1];
  let lastLine = '';
  if (last && last.outcomes[me()]?.length) {
    const parts = last.outcomes[me()].map((hand) => {
      const net = hand.result === 'win' ? hand.bet : hand.result === 'blackjack' ? hand.bet * 1.5 : hand.result === 'push' ? 0 : -hand.bet;
      const word = { win: 'won', blackjack: 'blackjack!', push: 'push', loss: 'lost', bust: 'bust' }[hand.result];
      const outcome = net > 0 ? 'win' : net < 0 ? 'loss' : 'neutral';
      return `<b class="blackjack-result ${outcome}">${word} ${net > 0 ? '+' : ''}${net}</b>`;
    });
    lastLine = `<div class="event-banner">Round ${last.round}: dealer had <b>${last.dealerValue}</b> — you ${parts.join(', ')}.</div>`;
  }

  const handBlock = (hand, index) => {
    const active = myTurn && index === state.currentHand && myHands.length > 1;
    const value = bjValue(hand.cards);
    return `<div class="blackjack-hand ${myHands.length > 1 ? 'split' : ''} ${active ? 'active' : ''}">
      <div class="card-fan">${hand.cards.map(pcardHtml).join('')}</div>
      <div class="stack atg-u-76b4bdfd47">
        <span class="mono atg-u-4139c9d292">${value.total}</span>
        <span class="faint atg-u-c42f23b8ec">${value.total > 21 ? 'bust' : value.soft ? 'soft total' : 'your total'}${hand.doubled ? ' · doubled' : ''}</span>
      </div>
      <span class="mono atg-u-6b0d948a6a">Bet ${hand.bet}</span>
    </div>`;
  };

  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${gameHeader('Blackjack', `Round ${Math.min(state.round, state.totalRounds)} / ${state.totalRounds}`, (state.round - 1) / state.totalRounds)}
    ${pausedBanner()}
    ${lastLine}
    <div class="stack atg-u-172782a1f3">
      <span class="kicker">Dealer shows</span>
      <div class="row atg-u-d56e3e3bc1">${state.dealer.map(pcardHtml).join('')}</div>
      <span class="faint atg-u-c42f23b8ec">Dealer stands on 17</span>
    </div>
    <div class="card stack atg-u-fb7367217c">
      <div class="row between">
        <span class="kicker">Your hand${myHands.length > 1 ? 's' : ''}</span>
        <span class="mono atg-u-21bcfd818e">Bankroll ${state.bankrolls[me()]}</span>
      </div>
      ${myHands.length ? myHands.map(handBlock).join('') : '<span class="muted atg-u-905228b6d5">Sitting this round out — bankroll below the 10-unit bet.</span>'}
    </div>
    ${others.length ? `
    <div class="stack atg-u-cbc596b74e">
      <span class="kicker">At your table</span>
      <div class="row wrap atg-u-d56e3e3bc1">
        ${others.map((p) => `<span class="player-chip ${state.currentPlayer === p.id ? 'current' : ''}">${nameTag(state, p)} <span class="mono atg-u-911ada6167">${state.bankrolls[p.id]}</span></span>`).join('')}
      </div>
    </div>` : ''}
    <div class="atg-u-13e71a9446">
    ${myTurn ? `
      <div class="grid-2">
        <button class="btn primary" data-bj="hit" ${legal.has('hit') ? '' : 'disabled'}>Hit</button>
        <button class="btn outline" data-bj="stand" ${legal.has('stand') ? '' : 'disabled'}>Stand</button>
        <button class="btn" data-bj="double" ${legal.has('double') ? '' : 'disabled'}>Double</button>
        <button class="btn" data-bj="split" ${legal.has('split') ? '' : 'disabled'}>Split</button>
      </div>` : waitingLine(state.currentPlayer ? `Waiting for <b>${esc(nameById(state, state.currentPlayer))}</b>…` : 'Dealer is finishing the round…')}
    </div>
  </div>`, 'game');
  setConn(stream?.readyState === 1);
  $$('[data-bj]').forEach((button) => button.addEventListener('click', () => act({ type: button.dataset.bj })));
}
function bjValue(cards) {
  let total = 0, aces = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (card.rank === 'A') { total += 11; aces += 1; }
    else if (['K', 'Q', 'J'].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

/* ----- leduc poker ----- */
function renderPoker(state) {
  const myTurn = state.currentPlayer === me() && state.legalActions.length > 0;
  const myCard = state.yourPrivateCard;
  const pub = state.publicCard;
  const pair = pub && myCard && pub.rank === myCard.rank;
  const raiseSize = state.bettingRound === 1 ? 2 : 4;

  const rows = state.players.map((player) => {
    const folded = state.folded[player.id];
    const current = state.currentPlayer === player.id;
    const isDealer = state.dealer === player.id;
    return `<div class="row between poker-player-row ${current ? 'current' : ''} ${folded ? 'folded' : ''}">
      <span class="poker-player-name ${player.id === me() ? 'you' : ''}">${nameTag(state, player)}${isDealer ? ' <span class="faint atg-u-025fe51291">· dealer</span>' : ''}${folded ? ' · folded' : current && player.id === me() ? ' · your turn' : ''}</span>
      <span class="mono poker-player-stack ${player.id === me() ? 'you' : ''}">stack ${state.stacks[player.id]}</span>
    </div>`;
  }).join('');

  const historyRows = state.actionHistory.slice(-4).reverse().map((row) =>
    `<div class="row between atg-u-21bcfd818e"><span>${esc(nameById(state, row.playerId))} ${({ raise: `raised ${row.round === 1 ? 2 : 4}`, call: 'called', check: 'checked', fold: 'folded' })[row.action] ?? row.action}</span><span class="mono">pot ${row.pot}</span></div>`
  ).join('');

  let showdownLine = '';
  if (state.lastShowdown && state.lastShowdown.hand === state.hand - 1) {
    const sd = state.lastShowdown;
    const winners = sd.winners.map((id) => nameById(state, id)).join(' & ');
    showdownLine = `<div class="event-banner">Hand ${sd.hand}: <b>${esc(winners)}</b> won the pot of <b>${sd.pot}</b>${sd.reason === 'folds' ? ' — everyone else folded' : ' at showdown'}.</div>`;
  }

  const buttons = state.legalActions.map((action) => {
    if (action.type === 'call') return `<button class="btn primary atg-u-558fe82ec5" data-poker="call">Call ${action.amount}</button>`;
    if (action.type === 'check') return `<button class="btn primary atg-u-558fe82ec5" data-poker="check">Check</button>`;
    if (action.type === 'raise') return `<button class="btn outline atg-u-558fe82ec5" data-poker="raise">Raise ${raiseSize}</button>`;
    return `<button class="btn atg-u-d698113df4" data-poker="fold">Fold</button>`;
  }).join('');

  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${gameHeader('Leduc Poker', `Hand ${Math.min(state.hand, state.totalHands)} / ${state.totalHands}`, (state.hand - 1) / state.totalHands)}
    ${pausedBanner()}
    ${showdownLine}
    <div class="atg-u-250e367ea7">
      <div class="stack atg-u-d9b64b90f9">
        <span class="pcard big"><span class="center">${myCard ? myCard.rank + 1 : '—'}</span></span>
        <span class="atg-u-0917b1c255">Your card</span>
      </div>
      <div class="stack atg-u-8447aed24d">
        <span class="kicker">Pot</span>
        <span class="mono atg-u-a6079ee252">${state.pot}</span>
        <span class="faint atg-u-025fe51291">round ${state.bettingRound} · raises of ${raiseSize}</span>
      </div>
      <div class="stack atg-u-d9b64b90f9">
        ${pub
          ? `<span class="pcard big community"><span class="center">${pub.rank + 1}</span></span><span class="community-label ${pair ? 'pair' : ''}">${pair ? 'Community — pair!' : 'Community'}</span>`
          : `<span class="pcard big atg-u-d3c6e734db"></span><span class="atg-u-e269f80a7a">Comes next round</span>`}
      </div>
    </div>
    <div class="stack atg-u-163fa40851">
      <span class="kicker">At your table</span>
      <div class="stack atg-u-c1e85f68fc">${rows}</div>
    </div>
    ${historyRows ? `
    <div class="stack atg-u-163fa40851">
      <span class="kicker">This hand so far</span>
      <div class="stack atg-u-dd84e0ab38">${historyRows}</div>
    </div>` : ''}
    <div class="atg-u-13e71a9446">
      ${myTurn ? `<div class="row atg-u-84dfe8ad07">${buttons}</div>` : waitingLine(state.currentPlayer ? `Waiting for <b>${esc(nameById(state, state.currentPlayer))}</b>…` : 'Dealing the next hand…')}
    </div>
  </div>`, 'game');
  setConn(stream?.readyState === 1);
  $$('[data-poker]').forEach((button) => button.addEventListener('click', () => act({ type: button.dataset.poker })));
}

/* ----- trading ----- */
function bindTradingControl(element, listener) {
  if (!element || tradingControlBindings.has(element)) return;
  tradingControlBindings.add(element);
  element.addEventListener('click', listener);
}

function refreshTradingControls(focusSelector) {
  if (snapshot?.room?.state?.game === 'trading') renderTrading(snapshot.room.state, { preserveClock: true });
  requestAnimationFrame(() => $(focusSelector)?.focus());
}

function bindTradingControls(state) {
  bindTradingControl($('#side-buy'), () => {
    orderForm.side = 'buy';
    refreshTradingControls('#side-buy');
  });
  bindTradingControl($('#side-sell'), () => {
    orderForm.side = 'sell';
    refreshTradingControls('#side-sell');
  });
  bindTradingControl($('#type-limit'), () => {
    orderForm.type = 'limit';
    refreshTradingControls('#type-limit');
  });
  bindTradingControl($('#type-market'), () => {
    orderForm.type = 'market';
    refreshTradingControls('#type-market');
  });
  bindTradingControl($('#price-down'), () => {
    orderForm.price = Math.max(1, orderForm.price - 1);
    refreshTradingControls(orderForm.price <= 1 ? '#price-up' : '#price-down');
  });
  bindTradingControl($('#price-up'), () => {
    orderForm.price = Math.min(250, orderForm.price + 1);
    refreshTradingControls(orderForm.price >= 250 ? '#price-down' : '#price-up');
  });
  bindTradingControl($('#oqty-down'), () => {
    orderForm.qty = Math.max(1, orderForm.qty - 1);
    refreshTradingControls(orderForm.qty <= 1 ? '#oqty-up' : '#oqty-down');
  });
  bindTradingControl($('#oqty-up'), () => {
    orderForm.qty = Math.min(5, orderForm.qty + 1);
    refreshTradingControls(orderForm.qty >= 5 ? '#oqty-down' : '#oqty-up');
  });
  bindTradingControl($('#submit-order'), () => {
    const action = { type: orderForm.type, side: orderForm.side, quantity: orderForm.qty };
    if (orderForm.type === 'limit') action.price = orderForm.price;
    return act(action);
  });
  for (const order of state.yourOrders) {
    const button = $(`[data-order-id="${order.id}"]`);
    bindTradingControl(button, () => act({ type: 'cancel', orderId: Number(button.dataset.orderId) }));
  }
}

function setTradingSelection(button, pressed) {
  if (!button) return;
  button.setAttribute('aria-pressed', String(pressed));
  button.classList.toggle('selected', pressed);
}

function syncTradingControls(state, running) {
  const isBuy = orderForm.side === 'buy';
  const isLimit = orderForm.type === 'limit';
  const interactive = running && !actionInFlight;
  const cost = orderForm.price * orderForm.qty;

  setTradingSelection($('#side-buy'), isBuy);
  setTradingSelection($('#side-sell'), !isBuy);
  setTradingSelection($('#type-limit'), isLimit);
  setTradingSelection($('#type-market'), !isLimit);

  const priceStepper = $('#trading-price-stepper');
  if (priceStepper) priceStepper.hidden = !isLimit;
  const priceValue = $('#trading-price-value');
  if (priceValue) priceValue.textContent = orderForm.price;
  const qtyValue = $('#trading-qty-value');
  if (qtyValue) qtyValue.textContent = orderForm.qty;
  const priceDown = $('#price-down');
  if (priceDown) priceDown.disabled = orderForm.price <= 1;
  const priceUp = $('#price-up');
  if (priceUp) priceUp.disabled = orderForm.price >= 250;
  const qtyDown = $('#oqty-down');
  if (qtyDown) qtyDown.disabled = orderForm.qty <= 1;
  const qtyUp = $('#oqty-up');
  if (qtyUp) qtyUp.disabled = orderForm.qty >= 5;

  const submit = $('#submit-order');
  if (submit) {
    submit.className = `btn block ${isBuy ? 'green' : 'red-solid'}`;
    submit.disabled = !interactive;
    submit.textContent = isLimit
      ? `${isBuy ? 'Buy' : 'Sell'} ${orderForm.qty} at ${orderForm.price} · ${isBuy ? 'costs' : 'gets'} ${cost}`
      : `${isBuy ? 'Buy' : 'Sell'} ${orderForm.qty} at market price`;
  }
  const capacity = $('#trading-capacity');
  if (capacity) capacity.textContent = `You can buy ${state.yourAvailableBuyQuantity} more · sell ${state.yourAvailableSellQuantity} more`;
  for (const order of state.yourOrders) {
    const cancel = $(`[data-order-id="${order.id}"]`);
    if (cancel) cancel.disabled = !interactive;
  }
  bindTradingControls(state);
}

function renderTrading(state, { preserveClock = false } = {}) {
  clearInterval(tradeTimer);
  tradeTimer = null;
  if (orderForm.price == null) orderForm.price = Math.max(1, Math.min(250, state.yourSignal));
  if (!preserveClock) tradeSeconds = state.secondsRemaining;
  const running = state.status !== 'completed' && snapshot.session.state === 'running' && !snapshot.room?.unhealthy && !snapshot.room?.seatControlledByBot;

  const levels = (orders) => {
    const map = new Map();
    for (const order of orders) map.set(order.price, (map.get(order.price) ?? 0) + order.remaining);
    return [...map.entries()].map(([price, qty]) => ({ price, qty }));
  };
  const bidLevels = levels(state.bids).slice(0, 5);
  const askLevels = levels(state.asks).slice(0, 5);
  const maxQty = Math.max(1, ...bidLevels.map((l) => l.qty), ...askLevels.map((l) => l.qty));
  const bestBid = bidLevels[0]?.price ?? null;
  const bestAsk = askLevels[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const lastTrade = state.recentTrades[state.recentTrades.length - 1];

  const cost = orderForm.price * orderForm.qty;
  const isBuy = orderForm.side === 'buy';
  const isLimit = orderForm.type === 'limit';
  const submitLabel = isLimit
    ? `${isBuy ? 'Buy' : 'Sell'} ${orderForm.qty} at ${orderForm.price} · ${isBuy ? 'costs' : 'gets'} ${cost}`
    : `${isBuy ? 'Buy' : 'Sell'} ${orderForm.qty} at market price`;
  const orderSignature = JSON.stringify(state.yourOrders.map(({ id, side, remaining, price }) => ({ id, side, remaining, price })));

  const orderRows = state.yourOrders.map((order) => `
    <div class="row between atg-u-d8f4a64ab0">
      <span class="atg-u-cdcef186c8"><b class="order-side ${order.side}">${order.side === 'buy' ? 'Buy' : 'Sell'}</b> <b class="mono">${order.remaining} @ ${order.price}</b> <span class="faint">· working</span></span>
      <button class="linkish danger cancel-order atg-u-5c8aff90b4" data-order-id="${order.id}" aria-label="Cancel ${order.side} order for ${order.remaining} at ${order.price}" ${running ? '' : 'disabled'}>Cancel</button>
    </div>`).join('');

  const tradeChips = state.recentTrades.slice(-6).reverse().map((trade, index) =>
    `<span class="pill tape-trade ${index === 0 ? 'latest' : ''} ${index > 1 ? 'older' : ''}">${trade.quantity} @ ${trade.price}</span>`).join('');

  const formCard = `
    <div class="card stack atg-u-b83dc11784">
      <span class="kicker">Place an order</span>
      <div class="seg">
        <button class="btn order-side-button buy ${isBuy ? 'selected' : ''}" id="side-buy" aria-pressed="${isBuy}">Buy</button>
        <button class="btn order-side-button sell ${!isBuy ? 'selected' : ''}" id="side-sell" aria-pressed="${!isBuy}">Sell</button>
      </div>
      <div class="seg">
        <button class="btn order-type-button ${isLimit ? 'selected' : ''}" id="type-limit" aria-pressed="${isLimit}">Set my price</button>
        <button class="btn order-type-button ${!isLimit ? 'selected' : ''}" id="type-market" aria-pressed="${!isLimit}">Instant</button>
      </div>
      <div class="row atg-u-d56e3e3bc1">
        <div class="stepper atg-u-48b62ab1f9" id="trading-price-stepper" ${isLimit ? '' : 'hidden'}>
          <button type="button" id="price-down" aria-label="Decrease order price" ${orderForm.price <= 1 ? 'disabled' : ''}>−</button>
          <span class="val"><small>PRICE</small><b id="trading-price-value">${orderForm.price}</b></span>
          <button type="button" id="price-up" aria-label="Increase order price" ${orderForm.price >= 250 ? 'disabled' : ''}>+</button>
        </div>
        <div class="stepper atg-u-6253876a64">
          <button type="button" id="oqty-down" aria-label="Decrease order quantity" ${orderForm.qty <= 1 ? 'disabled' : ''}>−</button>
          <span class="val"><small>QTY</small><b id="trading-qty-value">${orderForm.qty}</b></span>
          <button type="button" id="oqty-up" aria-label="Increase order quantity" ${orderForm.qty >= 5 ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <button class="btn block ${isBuy ? 'green' : 'red-solid'} atg-u-d870643db9" id="submit-order" ${running ? '' : 'disabled'}>${submitLabel}</button>
      <span class="faint atg-u-306e473278" id="trading-capacity">You can buy ${state.yourAvailableBuyQuantity} more · sell ${state.yourAvailableSellQuantity} more</span>
    </div>`;

  const bookCard = `
    <div class="card stack atg-u-b83dc11784">
      <div class="row between atg-u-a54a0e2dd1">
        <span class="kicker">Orders you can trade with</span>
        <span class="atg-u-e269f80a7a">${lastTrade ? `last trade <b class="mono atg-u-61ba8a4b16">${lastTrade.price}</b>` : 'no trades yet'}${spread != null ? ` · spread <b class="mono atg-u-61ba8a4b16">${spread}</b>` : ''}</span>
      </div>
      <div class="book">
        <div class="side">
          <div class="bh"><span>QTY</span><span>BUYERS</span></div>
          ${bidLevels.map((level) => `<div class="lvl bid"><span class="bar ${percentClass((level.qty / maxQty) * 85)}"></span><span class="mono">${level.qty}</span><span class="px b">${level.price}</span></div>`).join('') || '<div class="lvl"><span class="faint atg-u-c42f23b8ec">No buyers yet</span></div>'}
        </div>
        <div class="side">
          <div class="bh"><span>SELLERS</span><span>QTY</span></div>
          ${askLevels.map((level) => `<div class="lvl ask"><span class="bar ${percentClass((level.qty / maxQty) * 85)}"></span><span class="px a">${level.price}</span><span class="mono">${level.qty}</span></div>`).join('') || '<div class="lvl"><span class="faint atg-u-c42f23b8ec">No sellers yet</span></div>'}
        </div>
      </div>
      ${tradeChips ? `<div class="row wrap atg-u-ebac58e0be"><span class="kicker atg-u-6d5f02286b">Tape</span>${tradeChips}</div>` : ''}
    </div>`;

  const positionCard = `
    <div class="atg-u-76b39356a5">
      <div class="stack atg-u-535837de3e">
        <span class="atg-u-94e1ff9704">Cash</span>
        <span class="mono atg-u-fbe0480592">${state.yourCash.toFixed(2)}</span>
      </div>
      <div class="stack atg-u-f356439570">
        <span class="atg-u-94e1ff9704">Holding</span>
        <span class="mono atg-u-fbe0480592">${state.yourInventory > 0 ? '+' : ''}${state.yourInventory}</span>
      </div>
      <div class="stack atg-u-4c2a472957">
        <span class="atg-u-d124ca7cf6">Your hint</span>
        <span class="mono atg-u-4f45e1460d">≈${state.yourSignal}</span>
      </div>
    </div>
    <span class="faint atg-u-306e473278">Your hint is a rough estimate of what each unit pays out at the end — nobody knows the exact number.</span>`;

  const ordersCard = `
    <div class="card stack atg-u-84dfe8ad07">
      <span class="kicker">Your open orders</span>
      ${orderRows || '<span class="faint atg-u-cdcef186c8">None working right now.</span>'}
    </div>`;

  const layout = window.innerWidth >= 1080 ? 'wide' : 'narrow';
  const domOwner = `${snapshot.participant?.id ?? ''}:${snapshot.session?.id ?? ''}:${snapshot.room?.id ?? ''}`;
  const canPatch = currentScreen === 'trading' && tradingDomOwner === domOwner && tradingDomLayout === layout;

  if (canPatch) {
    setMarkup($('#trading-status'), pausedBanner());
    setMarkup($('#trading-position'), positionCard);
    setMarkup($('#trading-book'), bookCard);
    const orders = $('#trading-orders');
    if (orders.dataset.signature !== orderSignature) {
      setMarkup(orders, ordersCard);
      orders.dataset.signature = orderSignature;
    }
    const clock = $('#clock');
    if (clock) clock.textContent = fmtClock(tradeSeconds);
  } else {
    mount(`
  <div class="shell trading atg-u-c0d09338c8" id="trading-screen" data-layout="${layout}">
    ${gameHeader('Open Market', `<span id="clock">${fmtClock(tradeSeconds)}</span>`)}
    <div id="trading-status">${pausedBanner()}</div>
    <div class="trade-grid atg-u-e377464f6b">
      <div class="col stack atg-u-d56e3e3bc1"><div id="trading-position">${positionCard}</div>${layout === 'wide' ? `<div id="trading-orders">${ordersCard}</div>` : ''}</div>
      <div class="col">${layout === 'wide' ? `<div id="trading-book">${bookCard}</div>` : `<div id="trading-form">${formCard}</div>`}</div>
      <div class="col">${layout === 'wide' ? `<div id="trading-form">${formCard}</div>` : `<div id="trading-book">${bookCard}</div><div id="trading-orders">${ordersCard}</div>`}</div>
    </div>
  </div>`, 'trading');
    tradingDomOwner = domOwner;
    tradingDomLayout = layout;
    $('#trading-orders').dataset.signature = orderSignature;
  }
  setConn(stream?.readyState === 1);
  syncTradingControls(state, running);

  if (running) {
    tradeTimer = setInterval(() => {
      tradeSeconds = Math.max(0, tradeSeconds - 1);
      const clock = $('#clock');
      if (clock) clock.textContent = fmtClock(tradeSeconds);
    }, 1000);
  }

}

/* ----- done ----- */
function renderCancelling() {
  const gameLabel = snapshot.session ? shortGameName(snapshot.session.game) : 'Activity';
  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${brandHeader()}
    <div class="atg-u-f803207489">
      <div class="stack atg-u-d56e3e3bc1">
        <span class="kicker">${esc(gameLabel)} · cancellation in progress</span>
        <h1 class="serif atg-u-24d6aa3b20">Cancelling this activity…</h1>
        <p class="muted atg-u-38965f9b18">Your professor is ending the activity and preparing any decision records. Keep this page open.</p>
      </div>
      <div class="card atg-u-ee4a910191" role="status" aria-live="polite">Preparing your final screen…</div>
    </div>
  </div>`, 'cancelling');
  setConn(stream?.readyState === 1);
}

function renderDone(voided) {
  const state = snapshot.room?.state;
  const standings = state ? computeStandings(state) : [];
  const myRank = standings.findIndex((row) => row.id === me()) + 1;
  const gameLabel = snapshot.session ? shortGameName(snapshot.session.game) : 'Session';

  const standRows = standings.map((row, index) => `
    <div class="stand-row ${row.id === me() ? 'you' : ''}">
      <span>${index + 1} · ${esc(row.name)}${row.isBot && row.id !== me() ? ' <span class="tag-bot">BOT</span>' : ''}</span>
      <span class="mono atg-u-6b2a94ea3b">${row.display}</span>
    </div>`).join('');

  mount(`
  <div class="shell atg-u-c0d09338c8">
    ${brandHeader()}
    <div class="atg-u-f803207489">
      <div class="stack atg-u-d56e3e3bc1">
        <span class="kicker">${esc(gameLabel)} · ${voided ? 'cancelled' : 'complete'}</span>
        <h1 class="serif atg-u-24d6aa3b20">${voided ? 'This one was cancelled.' : `That's a wrap, ${firstName()}.`}</h1>
        ${voided ? `<p class="muted atg-u-38965f9b18">${snapshot.exportAvailable
          ? 'Your professor cancelled this activity — it won\'t count. Keep the decision record below if you need it, then sign out to join the next activity.'
          : 'Your professor cancelled this activity before play began. It won\'t count, and no game decisions were recorded. Sign out to join the next activity.'}</p>` : ''}
      </div>
      ${!voided && standings.length ? `
      <div class="card stack atg-u-b6f519633d">
        <div class="row between atg-u-a54a0e2dd1">
          <span class="kicker">Final standings</span>
          ${myRank ? `<span class="atg-u-1684f5e122">You placed ${ordinal(myRank)} of ${standings.length}</span>` : ''}
        </div>
        <div class="stack atg-u-ebac58e0be">${standRows}</div>
        ${state?.game === 'trading' && state.terminalValue != null ? `<div class="row between atg-u-8878e94889"><span class="faint">Each unit paid out</span><b class="mono">${state.terminalValue}</b></div>` : ''}
      </div>` : ''}
      ${snapshot.exportAvailable ? `
      <div class="packet-card stack atg-u-b83dc11784">
        <div>
          <div class="serif">${voided ? 'Your decision record is available' : 'Your coaching packet is ready'}</div>
          <p>${voided ? 'This activity will not count, but you can still keep a record of the choices you made.' : 'It records every choice you made. Upload it to ChatGPT and ask how you could have played better.'}</p>
        </div>
        <button class="btn paper block atg-u-4dcf0d07b9" id="download-packet">${voided ? 'Download decision record' : 'Download my packet'}</button>
      </div>` : ''}
      <button class="linkish" id="leave-device">Done — sign out of this device</button>
    </div>
  </div>`, 'done');
  setConn(stream?.readyState === 1);

  $('#download-packet')?.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/export', { credentials: 'same-origin' });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${snapshot.session.game}-${voided ? 'decision-record' : 'coaching-packet'}.md`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { toast(error.message); }
  });
  $('#leave-device')?.addEventListener('click', () => {
    signOut();
  });
}

function computeStandings(state) {
  let source = {};
  let format = (v) => String(v);
  if (state.game === 'rps' || state.game === 'liars_dice') { source = state.scores; format = (v) => (v > 0 ? `+${v}` : String(v)); }
  else if (state.game === 'blackjack') { source = state.bankrolls; }
  else if (state.game === 'poker') { source = state.stacks; }
  else if (state.game === 'trading') { source = state.pnl ?? {}; format = (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)); }
  return state.players
    .map((player) => ({ id: player.id, isBot: player.isBot, name: playerName(state, player), value: source[player.id] ?? 0, display: format(source[player.id] ?? 0) }))
    .sort((a, b) => b.value - a.value);
}
function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4)] ?? 'th';
  return `${n}${suffix}`;
}

restore();
