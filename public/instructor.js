/* Agentic Trading Games — instructor dashboard */

const csrf = document.querySelector('meta[name="csrf-token"]').content;
let state = null;
let stateRevision = null;
let stream = null;
let reconnectTimer = null;
let studentUrls = [];
let invitations = [];
let showSetup = false;
let pendingCancellation = null;
let cancellationSubmitting = false;
let mutationInFlight = false;
let projectorReturnFocus = null;
let projectorFullscreenRequested = false;

const setup = { game: 'rps', mode: 'live', rounds: {}, duration: 90, rosterText: '' };

const BOT_NAMES = ['Nash', 'Selten', 'Vickrey', 'Arrow', 'Harsanyi', 'Aumann', 'Shapley', 'Myerson', 'Schelling', 'Borel', 'Zermelo', 'Rubinstein', 'Osborne', 'Binmore', 'Gale'];

const GAME_CARDS = [
  { id: 'rps', name: 'Rock Paper Scissors', sub: 'Head-to-head, quick rounds', glyph: '<span class="atg-u-27124fd6f1"></span>' },
  { id: 'liars_dice', name: "Liar's Dice", sub: 'Tables of five, bluffing with dice', glyph: '<span class="atg-u-96eada1c29"><span class="atg-u-be675c4c39"></span><span class="atg-u-9b17298b83"></span></span>' },
  { id: 'blackjack', name: 'Blackjack', sub: 'Everyone against the dealer', glyph: '<span class="atg-u-7f4b0b53f3"><span class="atg-u-70b6fbbf4a"></span><span class="atg-u-0477ea038c"></span></span>' },
  { id: 'poker', name: 'Leduc Poker', sub: 'One card each, simple betting', glyph: '<span class="atg-u-209c4cb632"></span>' },
  { id: 'trading', name: 'Trading', sub: 'A live market on the clock', glyph: '<span class="atg-u-a153bdf393"><span class="atg-u-2a0a2ecc91"></span><span class="atg-u-6f1eab7a21"></span><span class="atg-u-e904beb6c9"></span><span class="atg-u-917f264a48"></span></span>' },
];
const MODE_CARDS = [
  { id: 'random', name: 'Practice bots', sub: 'Each student gets a private table of bots that play unpredictably. Good for a first try.' },
  { id: 'strategy', name: 'Adaptive bots', sub: "Bots that study each student's habits and exploit them. Harder to beat." },
  { id: 'live', name: 'Live classroom', sub: 'Students play each other at tables. Empty seats are filled by bots.' },
];
const MODE_LABEL = { random: 'Practice bots', strategy: 'Adaptive bots', live: 'Live classroom' };
const GAME_LABEL = { rps: 'Rock Paper Scissors', liars_dice: "Liar's Dice", blackjack: 'Blackjack', poker: 'Leduc Poker', trading: 'Trading' };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

function setMarkup(element, html) {
  element.innerHTML = html;
}

function percentClass(value) {
  return `atg-pct-${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}`;
}

function stableInstructorFocusSelector(element, fallback = '#view') {
  const id = String(element?.id ?? '').replace(/^#/, '');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  const dataAttributes = [
    ['remove', 'data-remove'],
    ['voidRoom', 'data-void-room'],
    ['replace', 'data-replace'],
    ['restore', 'data-restore'],
    ['rotateInvite', 'data-rotate-invite'],
    ['revokeInvite', 'data-revoke-invite'],
  ];
  for (const [property, attribute] of dataAttributes) {
    if (element?.dataset?.[property]) return `[${attribute}="${element.dataset[property]}"]`;
  }
  return fallback;
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
  el.textContent = message;
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
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-Token': csrf,
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed: ${response.status}`);
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.blob();
}

function sessionIsTransitioning() {
  return ['pausing', 'resuming', 'ending', 'voiding'].includes(state?.session?.state);
}

function syncMutationControls() {
  const shouldLock = mutationInFlight || sessionIsTransitioning();
  const controls = $$('#create, #start, #pause-resume, #end, #void-session, #purge-archives, #audit-export, #audit-export-json, [data-remove], [data-void-room], [data-replace], [data-restore], [data-rotate-invite], [data-revoke-invite]');
  controls.forEach((button) => {
    if (shouldLock) {
      if (!button.disabled) button.dataset.mutationLocked = 'true';
      button.disabled = true;
    } else if (button.dataset.mutationLocked === 'true') {
      button.disabled = false;
      delete button.dataset.mutationLocked;
    }
  });
}

async function mutate(path, body = {}, { onError = toast, onSuccess = () => {} } = {}) {
  if (mutationInFlight) {
    onError('Another classroom change is still being saved.');
    return false;
  }
  mutationInFlight = true;
  syncMutationControls();
  let result;
  try {
    result = await api(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    mutationInFlight = false;
    syncMutationControls();
    onError(error.message);
    return false;
  }
  mutationInFlight = false;
  clearToast();
  absorb(result);
  onSuccess(result);
  render();
  return true;
}

function requestCancellation({
  path,
  title,
  description,
  note = '',
  confirmLabel,
  body = {},
  showNote = true,
  kicker = 'Cancellation',
  focusAfter = '#view',
}) {
  const dialog = $('#cancel-dialog');
  pendingCancellation = {
    path,
    note,
    body,
    showNote,
    focusAfter,
    triggerSelector: stableInstructorFocusSelector(document.activeElement),
  };
  cancellationSubmitting = false;
  $('#cancel-dialog-kicker').textContent = kicker;
  $('#cancel-dialog-title').textContent = title;
  $('#cancel-dialog-description').textContent = description;
  $('#cancel-note').value = note;
  $('#cancel-note').required = showNote;
  $('#cancel-note').disabled = false;
  $('#cancel-note-field').hidden = !showNote;
  $('#cancel-dialog-close').disabled = false;
  $('#cancel-dialog-close').textContent = showNote ? 'Keep playing' : 'Go back';
  $('#cancel-dialog-confirm').textContent = confirmLabel;
  $('#cancel-dialog-confirm').disabled = false;
  $('#cancel-dialog-error').hidden = true;
  dialog.showModal();
  requestAnimationFrame(() => {
    if (!dialog.open) return;
    if (showNote) $('#cancel-note').select();
    else $('#cancel-dialog-close').focus();
  });
}

function closeCancellation({ focusResult = false } = {}) {
  if (cancellationSubmitting) return;
  const cancellation = pendingCancellation;
  pendingCancellation = null;
  $('#cancel-dialog').close();
  const focusTarget = (focusResult
    ? $(cancellation?.focusAfter ?? '#view')
    : (cancellation?.triggerSelector ? $(cancellation.triggerSelector) : null)
      ?? $(cancellation?.focusAfter ?? '#view')
  ) ?? $('#view');
  focusTarget?.focus?.({ preventScroll: true });
}

$('#cancel-dialog-close').addEventListener('click', closeCancellation);
$('#cancel-dialog').addEventListener('keydown', (event) => {
  trapDialogTab($('#cancel-dialog'), event);
});
$('#cancel-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!cancellationSubmitting) closeCancellation();
});
$('#cancel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const cancellation = pendingCancellation;
  if (!cancellation || cancellationSubmitting) return;
  const button = $('#cancel-dialog-confirm');
  const closeButton = $('#cancel-dialog-close');
  const noteInput = $('#cancel-note');
  const error = $('#cancel-dialog-error');
  const body = { ...cancellation.body };
  if (cancellation.showNote) body.note = $('#cancel-note').value.trim() || cancellation.note;
  cancellationSubmitting = true;
  button.disabled = true;
  closeButton.disabled = true;
  noteInput.disabled = true;
  error.hidden = true;
  const succeeded = await mutate(cancellation.path, body, {
    onError: (message) => {
      error.textContent = message;
      error.hidden = false;
    }
  });
  cancellationSubmitting = false;
  if (succeeded) closeCancellation({ focusResult: true });
  else {
    button.disabled = false;
    closeButton.disabled = false;
    noteInput.disabled = false;
    (cancellation.showNote ? noteInput : button).focus();
  }
});

async function download(path, filename, accept = 'text/markdown') {
  try {
    const blob = await api(path, { headers: { Accept: accept } });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) { toast(error.message); }
}

function absorb(data) {
  const revision = Number.isSafeInteger(data?.revision) ? data.revision : null;
  if (revision != null && stateRevision != null && revision < stateRevision) return false;
  const changedSession = state?.session?.id && data.session?.id && state.session.id !== data.session.id;
  if (changedSession) invitations = [];
  if (Array.isArray(data.studentUrls)) studentUrls = data.studentUrls;
  if (Array.isArray(data.invitations)) {
    for (const invitation of data.invitations) {
      invitations = invitations.filter((candidate) => candidate.identity !== invitation.identity);
      invitations.push(invitation);
    }
  }
  if (data.revokedInvitationIdentity) invitations = invitations.filter((candidate) => candidate.identity !== data.revokedInvitationIdentity);
  if (Array.isArray(data.roster)) {
    const inactive = new Set(data.roster.filter((entry) => entry.redeemed || entry.revoked).map((entry) => entry.identity));
    invitations = invitations.filter((candidate) => !inactive.has(candidate.identity));
  }
  state = data;
  if (revision != null) stateRevision = revision;
  return true;
}

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (stream) stream.close();
  const connection = new EventSource('/api/instructor/events');
  stream = connection;
  connection.onopen = () => { if (stream === connection) setConn(true); };
  connection.onerror = () => {
    if (stream !== connection) return;
    setConn(false);
    if (connection.readyState === EventSource.CLOSED) {
      stream = null;
      reconnectTimer = setTimeout(connect, 1500);
    }
  };
  const receive = (event) => {
    if (stream === connection && absorb(JSON.parse(event.data))) render();
  };
  for (const type of ['snapshot', 'health', 'session_update', 'room_update']) connection.addEventListener(type, receive);
}

function setConn(online) {
  const el = $('#conn');
  el.className = online ? 'conn' : 'conn reconnecting';
  el.innerHTML = online ? '<span class="dot"></span>Connected' : '<span class="dot amber"></span>Reconnecting…';
}

/* ---------- helpers ---------- */
function joinUrls() {
  return studentUrls.map((url) => `${url.replace(/\/$/, '')}/`);
}
function fmtCode(code) { return `${String(code).slice(0, 3)} ${String(code).slice(3)}`; }
function fmtClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function botName(room, playerId) {
  const index = room.players.filter((p) => p.isBot).findIndex((p) => p.id === playerId);
  return BOT_NAMES[index % BOT_NAMES.length];
}
function tableNumber(roomId) {
  return state.rooms.findIndex((room) => room.id === roomId) + 1;
}
function roomProgress(room) {
  if (room.status === 'voided') return { text: 'Cancelled', frac: 1, done: true };
  const progress = String(room.progress ?? '');
  if (progress.includes('/')) {
    const [a, b] = progress.split('/').map(Number);
    const finished = room.status === 'completed';
    return { text: finished ? 'Finished' : `Round ${a} of ${b}`, frac: finished ? 1 : Math.max(0, (a - 1) / b), done: finished };
  }
  if (progress.endsWith('s')) {
    const secondsLeft = Number(progress.slice(0, -1));
    const total = state.session?.config?.duration ?? 90;
    const finished = room.status === 'completed' || secondsLeft <= 0;
    return { text: finished ? 'Finished' : `${fmtClock(secondsLeft)} left`, frac: finished ? 1 : 1 - secondsLeft / total, done: finished };
  }
  return { text: room.status === 'completed' ? 'Finished' : '', frac: room.status === 'completed' ? 1 : 0, done: room.status === 'completed' };
}
function sessionLine(session) {
  const config = session.config ?? {};
  const length = session.game === 'trading' ? `${fmtClock(config.duration ?? 90)} on the clock` : `${config.rounds} rounds`;
  return `${GAME_LABEL[session.game] ?? session.gameName} · ${MODE_LABEL[session.mode] ?? session.mode} · ${length}`;
}

/* ---------- render ---------- */
function render() {
  if (!state) return;
  const modalOpen = $('#cancel-dialog')?.open || $('#projector')?.open;
  const focusSelector = modalOpen ? null : stableInstructorFocusSelector(document.activeElement, null);
  try {
    const session = state.session;
    const finished = session && ['completed', 'voided', 'archived'].includes(session.state);
    if (!session || showSetup) renderSetup();
    else if (finished) renderDone();
    else if (session.state === 'lobby') renderLobby();
    else renderLive();
    syncProjector();
    syncMutationControls();
  } finally {
    if (focusSelector) requestAnimationFrame(() => {
      if ($('#cancel-dialog')?.open || $('#projector')?.open) return;
      const target = $(focusSelector);
      if (target && !target.disabled) target.focus({ preventScroll: true });
    });
  }
}

/* ----- setup ----- */
function renderSetup() {
  const meta = state.games?.[setup.game] ?? {};
  const isTrading = setup.game === 'trading';
  if (!isTrading && setup.rounds[setup.game] == null) setup.rounds[setup.game] = meta.defaultRounds ?? 8;
  const roundsValue = setup.rounds[setup.game];
  const previous = state.session && ['completed', 'voided', 'archived'].includes(state.session.state);
  const lengthValue = isTrading ? setup.duration : roundsValue;
  const lengthMin = isTrading ? (meta.minDuration ?? 30) : (meta.minRounds ?? 1);
  const lengthMax = isTrading ? (meta.maxDuration ?? 300) : (meta.maxRounds ?? 100);
  const lengthNoun = isTrading ? 'market duration' : setup.game === 'poker' ? 'hands' : 'rounds';

  setMarkup($('#view'), `
  <div class="atg-u-f1fe34f4ce">
    ${previous ? `<button class="linkish atg-u-c18b3bf9a8" id="back-done">← Back to the last activity</button>` : ''}
    <div class="stack atg-u-ebac58e0be">
      <h1 class="serif atg-u-6922544a4f">Set up today's activity</h1>
      <p class="muted atg-u-38965f9b18">Configure the activity, then privately deliver each personal invitation.</p>
    </div>
    <div class="stack atg-u-9bee47f62a">
      <div class="row atg-u-16d9745738"><span class="mono atg-u-d9610fdc40">1</span><b class="atg-u-e49c04bf11">Pick a game</b></div>
      <div class="atg-u-31957b9686">
        ${GAME_CARDS.map((card) => `
          <button type="button" class="game-pick ${setup.game === card.id ? 'on' : ''}" data-game="${card.id}" aria-pressed="${setup.game === card.id}">
            <span class="glyph">${card.glyph}</span>
            <span class="gname">${card.name}</span>
            <span class="gsub">${card.sub}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="stack atg-u-9bee47f62a">
      <div class="row atg-u-16d9745738"><span class="mono atg-u-d9610fdc40">2</span><b class="atg-u-e49c04bf11">Who plays against whom?</b></div>
      <div class="atg-u-796242f45c">
        ${MODE_CARDS.map((card) => `
          <button type="button" class="game-pick ${setup.mode === card.id ? 'on' : ''}" data-mode="${card.id}" aria-pressed="${setup.mode === card.id}">
            <span class="gtitle">${card.name}</span>
            <span class="gsub atg-u-8442ba96f5">${card.sub}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="stack atg-u-9bee47f62a">
      <div class="row atg-u-16d9745738"><span class="mono atg-u-d9610fdc40">3</span><b class="atg-u-e49c04bf11">Paste the class roster</b></div>
      <label class="field" for="roster-input">
        <span>One student per line: institutional ID, display name</span>
        <textarea id="roster-input" class="input" rows="7" maxlength="24000" spellcheck="false" placeholder="s12345, Maya Chen&#10;s12346, Jordan Lee">${esc(setup.rosterText)}</textarea>
      </label>
      <span class="faint atg-u-cdcef186c8">A line with one value uses that value for both identity and display name. Identities must be unique.</span>
    </div>
    <div class="row between wrap atg-u-e1dc5a731a">
      <div class="stack atg-u-9bee47f62a">
        <div class="row atg-u-16d9745738"><span class="mono atg-u-d9610fdc40">4</span><b class="atg-u-e49c04bf11">How long?</b></div>
        <div class="stepper atg-u-251288a3fe">
          <button class="atg-u-de97c03020" type="button" id="len-down" aria-label="Decrease ${lengthNoun}" ${lengthValue <= lengthMin ? 'disabled' : ''}>−</button>
          <span class="val">
            ${isTrading
              ? `<b class="atg-u-bf9d57d795">${fmtClock(setup.duration)}</b> <span class="atg-u-8442ba96f5">on the clock</span>`
              : `<b class="atg-u-bf9d57d795">${roundsValue}</b> <span class="atg-u-8442ba96f5">${setup.game === 'poker' ? 'hands' : 'rounds'}</span>`}
          </span>
          <button class="atg-u-de97c03020" type="button" id="len-up" aria-label="Increase ${lengthNoun}" ${lengthValue >= lengthMax ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <button class="btn primary atg-u-6cf46a0a15" id="create" ${setup.rosterText.trim() ? '' : 'disabled'}>Create invites and open the room →</button>
    </div>
  </div>`);

  if (previous) $('#back-done').addEventListener('click', () => { showSetup = false; render(); });
  $$('[data-game]').forEach((button) => button.addEventListener('click', () => {
    setup.game = button.dataset.game;
    render();
    requestAnimationFrame(() => $(`[data-game="${setup.game}"]`)?.focus());
  }));
  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    setup.mode = button.dataset.mode;
    render();
    requestAnimationFrame(() => $(`[data-mode="${setup.mode}"]`)?.focus());
  }));
  $('#roster-input').addEventListener('input', (event) => {
    setup.rosterText = event.target.value;
    $('#create').disabled = !setup.rosterText.trim();
  });
  $('#len-down').addEventListener('click', () => {
    bumpLength(-1);
    render();
    requestAnimationFrame(() => ($('#len-down')?.disabled ? $('#len-up') : $('#len-down'))?.focus());
  });
  $('#len-up').addEventListener('click', () => {
    bumpLength(1);
    render();
    requestAnimationFrame(() => ($('#len-up')?.disabled ? $('#len-down') : $('#len-up'))?.focus());
  });
  $('#create').addEventListener('click', async () => {
    const roster = setup.rosterText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const comma = line.indexOf(',');
      if (comma < 0) return { identity: line, name: line };
      return { identity: line.slice(0, comma).trim(), name: line.slice(comma + 1).trim() };
    });
    const body = { game: setup.game, mode: setup.mode, roster };
    if (setup.game === 'trading') body.duration = setup.duration;
    else body.rounds = setup.rounds[setup.game];
    await mutate('/api/instructor/session', body, { onSuccess: () => { showSetup = false; } });
  });
}
function bumpLength(direction) {
  const meta = state.games?.[setup.game] ?? {};
  if (setup.game === 'trading') {
    setup.duration = Math.max(meta.minDuration ?? 30, Math.min(meta.maxDuration ?? 300, setup.duration + direction * 15));
  } else {
    const step = setup.game === 'rps' ? 5 : 1;
    setup.rounds[setup.game] = Math.max(meta.minRounds ?? 1, Math.min(meta.maxRounds ?? 100, (setup.rounds[setup.game] ?? 8) + direction * step));
  }
}

function requestRetentionPurge(focusAfter = '#view') {
  requestCancellation({
    path: '/api/instructor/purge',
    title: 'Permanently purge records past the retention date?',
    description: 'Eligible completed or cancelled activities, including the latest one when old enough, will be permanently deleted. This cannot be undone.',
    confirmLabel: 'Purge expired records',
    body: { confirmation: 'PURGE ARCHIVED DATA' },
    showNote: false,
    kicker: 'Data retention',
    focusAfter,
  });
}

/* ----- lobby ----- */
function renderLobby() {
  const session = state.session;
  const students = state.participants;
  const urls = joinUrls();
  const invitationRows = invitations.map((invitation) => `
    <div class="student-row">
      <span class="stack atg-u-a8bebe80a2"><b>${esc(invitation.name)}</b><span class="faint mono atg-u-c42f23b8ec">${esc(invitation.identity)}</span></span>
      <code class="mono atg-u-3cc84729e0">${esc(invitation.inviteCode)}</code>
    </div>`).join('');
  const pendingRoster = (state.roster ?? []).filter((entry) => !entry.redeemed && !entry.revoked);
  const recoverableRoster = (state.roster ?? []).filter((entry) => entry.reissuable);

  setMarkup($('#view'), `
  <div class="row between wrap atg-u-9ca8fd1673">
    <span class="atg-u-5d4ec04154">${esc(sessionLine(session))}</span>
    <span class="pill atg-u-2dd7286cc8">Doors open</span>
  </div>
  <div class="instructor-lobby-grid atg-u-5048ad7e39">
    <div class="stack atg-u-d3fdf155aa">
      <div class="code-card stack atg-u-76b4bdfd47">
        <div class="stack atg-u-ebac58e0be">
          <span class="kicker">Students join at</span>
          <span class="url">${urls.length ? urls.map((url) => esc(url)).join('<br>') : 'the address shown in your server window'}</span>
        </div>
        <div class="rule"></div>
        <div class="stack atg-u-ebac58e0be">
          <span class="kicker">Class code</span>
          <span class="code">${fmtCode(session.joinCode)}</span>
        </div>
        <button class="btn paper block atg-u-ba21b3b743" id="open-projector">Show on the projector ↗</button>
      </div>
      ${invitations.length ? `
      <div class="card stack atg-u-b83dc11784">
        <div class="stack atg-u-dd84e0ab38">
          <span class="kicker">One-time personal invites</span>
          <span class="faint atg-u-cdcef186c8">Save these now. For security, the server will not reveal them again after this page reloads.</span>
        </div>
        <div class="stack atg-u-3ad5d1b06c">${invitationRows}</div>
        <button class="btn quiet block" id="download-invitations">Download invitation CSV</button>
      </div>` : ''}
      <div class="stack atg-u-84dfe8ad07">
        <button class="btn green block atg-u-60a211ecb4" id="start" ${students.length ? '' : 'disabled'}>Start the game for everyone</button>
        <span class="faint atg-u-62be2c3ca7">${students.length ? 'Starting closes the doors — no one else can join.' : 'Waiting for the first student to join…'}</span>
      </div>
      <button class="linkish danger atg-u-192d1139cc" id="void-session">Cancel this activity</button>
      <button class="linkish danger atg-u-192d1139cc" id="purge-archives">Purge records past retention date</button>
    </div>
    <div class="stack atg-u-d3fdf155aa">
      <div class="row between atg-u-a54a0e2dd1">
        <b class="atg-u-e49c04bf11" id="roster-heading" tabindex="-1">Who's here</b>
        <span class="mono atg-u-14297af435">${students.length}</span>
      </div>
      <div class="row wrap atg-u-cbb5d177de">
        ${students.map((p) => `
          <span class="roster-chip">
            <span class="dot ${p.connected ? '' : 'off'}"></span>${esc(p.name)}
            <button class="rm" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}" title="Remove ${esc(p.name)}">✕</button>
          </span>`).join('') || '<span class="muted atg-u-905228b6d5">Nobody yet. Students need both the displayed class code and their assigned personal invitation.</span>'}
      </div>
      ${students.length ? '<span class="faint atg-u-cdcef186c8">Use × to remove someone who shouldn\'t be here.</span>' : ''}
      ${pendingRoster.length ? `
      <div class="stack atg-u-3466a30046">
        <span class="kicker">Invited, not yet joined</span>
        ${pendingRoster.map((entry) => `
          <div class="student-row">
            <span><b>${esc(entry.name)}</b> <span class="faint mono">${esc(entry.identity)}</span></span>
            <span class="row atg-u-ebac58e0be">
              <button class="btn tiny quiet" data-rotate-invite="${entry.id}">Replace invite</button>
              <button class="btn tiny danger" data-revoke-invite="${entry.id}">Revoke</button>
            </span>
          </div>`).join('')}
      </div>` : ''}
      ${recoverableRoster.length ? `
      <div class="stack atg-u-3466a30046">
        <span class="kicker">Removed or revoked — recovery available</span>
        ${recoverableRoster.map((entry) => `
          <div class="student-row">
            <span><b>${esc(entry.name)}</b> <span class="faint mono">${esc(entry.identity)}</span></span>
            <button class="btn tiny quiet" data-rotate-invite="${entry.id}">Issue new invite</button>
          </div>`).join('')}
      </div>` : ''}
    </div>
  </div>`);

  $('#open-projector').addEventListener('click', () => openProjector());
  $('#download-invitations')?.addEventListener('click', () => {
    const quote = (value) => {
      const raw = String(value);
      const spreadsheetSafe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
    };
    const studentUrl = urls[0] ?? '';
    const rows = [
      ['identity', 'name', 'student_url', 'class_code', 'personal_invite'],
      ...invitations.map((invitation) => [invitation.identity, invitation.name, studentUrl, session.joinCode, invitation.inviteCode]),
    ];
    const blob = new Blob([rows.map((row) => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `class-invitations-${session.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });
  $('#start').addEventListener('click', () => mutate('/api/instructor/session/start'));
  $('#void-session').addEventListener('click', () => requestCancellation({
    path: '/api/instructor/session/void',
    title: 'Cancel this activity?',
    description: "It won't count, and students will see that it was cancelled.",
    note: 'Cancelled before starting',
    confirmLabel: 'Cancel activity',
    focusAfter: '#new-activity'
  }));
  $('#purge-archives').addEventListener('click', () => requestRetentionPurge('#start'));
  $$('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    const student = state.participants.find((p) => p.id === button.dataset.remove);
    requestCancellation({
      path: `/api/instructor/participant/${button.dataset.remove}/remove`,
      title: `Remove ${student?.name ?? 'this student'}?`,
      description: 'They will be signed out of this activity and can only return by joining again while the doors are open.',
      confirmLabel: 'Remove student',
      showNote: false,
      kicker: 'Roster',
      focusAfter: '#roster-heading'
    });
  }));
  $$('[data-rotate-invite]').forEach((button) => button.addEventListener('click', () => {
    mutate(`/api/instructor/roster/${button.dataset.rotateInvite}/rotate`);
  }));
  $$('[data-revoke-invite]').forEach((button) => button.addEventListener('click', () => {
    mutate(`/api/instructor/roster/${button.dataset.revokeInvite}/revoke`);
  }));
}

/* ----- live ----- */
function renderLive() {
  const session = state.session;
  const paused = ['paused', 'pausing'].includes(session.state);
  const stable = ['running', 'paused'].includes(session.state);
  const statusLabel = ({
    pausing: 'Pausing…',
    paused: 'Paused',
    resuming: 'Resuming…',
    ending: 'Ending…',
    voiding: 'Cancelling…',
  })[session.state] ?? 'Running';
  const health = state.health;
  const unhealthyCount = state.rooms.filter((room) => room.unhealthy).length;
  const playing = state.rooms.filter((room) => !['completed', 'voided', 'unhealthy'].includes(room.status)).length;
  const allGood = unhealthyCount === 0 && health.connected === health.total;

  const tables = state.rooms.map((room) => {
    const n = tableNumber(room.id);
    const progress = roomProgress(room);
    const canVoid = stable && !['completed', 'voided'].includes(room.status);
    const chips = room.players.map((player) => {
      const participant = state.participants.find((p) => p.id === player.id);
      if (player.isBot && participant) return `<span class="tchip away">${esc(participant.name)} — bot filling in</span>`;
      if (player.isBot) return `<span class="tchip atg-u-865d65071c">${esc(botName(room, player.id))} · bot</span>`;
      if (participant && !participant.connected) return `<span class="tchip away">${esc(player.name)} — away</span>`;
      return `<span class="tchip">${esc(player.name)}</span>`;
    }).join('');
    return `
    <div class="table-card ${room.unhealthy ? 'warn' : ''}" data-room-id="${room.id}" tabindex="-1">
      <div class="row between">
        <b class="atg-u-905228b6d5">Table ${n}</b>
        <span class="mono atg-u-bb625bb7d8">${progress.text}</span>
      </div>
      <div class="progress-track atg-u-38965f9b18"><div class="progress-fill ${percentClass(progress.frac * 100)} ${room.unhealthy ? 'warn' : room.status === 'voided' ? 'voided' : 'healthy'}"></div></div>
      <div class="row wrap atg-u-c1e85f68fc">${chips}</div>
      ${room.unhealthy ? '<div class="atg-u-413bd3b5c0">This table hit a problem — cancel it so its students can move on.</div>' : ''}
      ${canVoid ? `<button class="btn small ${room.unhealthy ? 'danger' : 'quiet'}" data-void-room="${room.id}">Cancel this table</button>` : ''}
    </div>`;
  }).join('');

  const studentRows = state.participants.map((participant) => {
    const room = state.rooms.find((candidate) => candidate.id === participant.roomId);
    const seat = room?.players.find((player) => player.id === participant.id);
    const botFilling = Boolean(seat?.isBot);
    const away = !participant.connected && !botFilling;
    const roomActive = Boolean(room && !room.unhealthy && !['completed', 'voided'].includes(room.status));
    const packetReady = ['completed', 'voided'].includes(room?.status);
    let action = '';
    if (botFilling && participant.connected && stable && roomActive) action = `<button class="btn tiny quiet" data-restore="${participant.id}">Give the seat back</button>`;
    else if (botFilling && !participant.connected && roomActive) action = '<span class="faint atg-u-c42f23b8ec">Reconnect to take back the seat</span>';
    else if (away && stable && roomActive) action = `<button class="btn tiny quiet" data-replace="${participant.id}">Fill seat with a bot</button>`;
    const packetLabel = room?.status === 'voided' ? 'Decision record' : 'Packet';
    return `
    <div class="student-row ${botFilling || away ? 'away' : ''}">
      <span class="row atg-u-23281ee94c">
        <span class="dot ${botFilling ? 'amber' : participant.connected ? '' : 'off'}"></span>
        <b class="atg-u-ba32d67296">${esc(participant.name)}</b>
        <span class="faint atg-u-aa8cdff728">${botFilling ? 'bot filling in' : away ? 'away' : room ? `Table ${tableNumber(room.id)}` : ''}</span>
      </span>
      <span class="row atg-u-7dcba5a29d">
        ${action}
        <button class="btn tiny quiet" data-packet="${participant.id}" ${packetReady ? '' : 'disabled'}>${packetLabel}</button>
      </span>
    </div>`;
  }).join('');

  setMarkup($('#view'), `
  <div class="status-banner">
    <span class="row atg-u-45757b7025">
      <span class="dot ${allGood ? '' : 'amber'} atg-u-8c79b369f9"></span>
      <b>${allGood ? 'All good.' : 'Needs a look.'}</b>
      <span class="muted">${health.connected} of ${health.total} students connected · ${playing} table${playing === 1 ? '' : 's'} playing${unhealthyCount ? ` · ${unhealthyCount} table${unhealthyCount === 1 ? '' : 's'} need attention` : ''}</span>
    </span>
    <span class="row atg-u-5d54f7290f">
      <span class="atg-u-5d4ec04154">${esc(sessionLine(session))}</span>
      <span class="pill instructor-status ${session.state === 'running' ? 'running' : 'transitioning'}">
        <span class="dot ${session.state === 'running' ? '' : 'amber'} atg-u-2bd8ce2778"></span>${statusLabel}
      </span>
      <button class="btn small quiet" id="pause-resume">${session.state === 'pausing' ? 'Pausing…' : session.state === 'resuming' ? 'Resuming…' : paused ? 'Resume for everyone' : 'Pause everyone'}</button>
      <button class="btn small quiet" id="end">${session.state === 'ending' ? 'Ending…' : 'End early'}</button>
    </span>
  </div>
  <div class="instructor-live-grid atg-u-98f6d86edc">
    <div class="stack atg-u-9bee47f62a">
      <b class="atg-u-e49c04bf11">Tables</b>
      <div class="atg-u-a09e6e495f">${tables}</div>
    </div>
    <div class="stack atg-u-9bee47f62a">
      <div class="row between atg-u-a54a0e2dd1">
        <b class="atg-u-e49c04bf11">Students</b>
        <span class="faint atg-u-cdcef186c8">packets unlock when tables finish</span>
      </div>
      <div class="stack atg-u-d56e3e3bc1">${studentRows}</div>
      <button class="linkish danger atg-u-192d1139cc" id="void-session">Cancel this activity</button>
    </div>
  </div>`);

  $('#pause-resume').addEventListener('click', () => mutate(paused ? '/api/instructor/session/resume' : '/api/instructor/session/pause'));
  $('#end').addEventListener('click', () => requestCancellation({
    path: '/api/instructor/session/end',
    title: 'End the activity now?',
    description: 'Tables will finish where they are and coaching packets will unlock.',
    confirmLabel: 'End activity',
    showNote: false,
    kicker: 'Finish early',
    focusAfter: '#new-activity'
  }));
  $('#void-session').addEventListener('click', () => requestCancellation({
    path: '/api/instructor/session/void',
    title: 'Cancel this activity?',
    description: "It won't count, but decision records will stay available.",
    note: 'Classroom interruption',
    confirmLabel: 'Cancel activity',
    focusAfter: '#new-activity'
  }));
  $$('[data-void-room]').forEach((button) => button.addEventListener('click', () => {
    const room = state.rooms.find((candidate) => candidate.id === button.dataset.voidRoom);
    const number = tableNumber(button.dataset.voidRoom);
    requestCancellation({
      path: `/api/instructor/room/${button.dataset.voidRoom}/void`,
      title: `Cancel Table ${number}?`,
      description: 'This table will stop and its results will not count. Decision records will stay available.',
      note: room?.unhealthy ? 'Technical issue' : 'Classroom interruption',
      confirmLabel: `Cancel Table ${number}`,
      focusAfter: `[data-room-id="${button.dataset.voidRoom}"]`
    });
  }));
  $$('[data-replace]').forEach((button) => button.addEventListener('click', () => mutate(`/api/instructor/participant/${button.dataset.replace}/replace`)));
  $$('[data-restore]').forEach((button) => button.addEventListener('click', () => mutate(`/api/instructor/participant/${button.dataset.restore}/restore`)));
  $$('[data-packet]').forEach((button) => button.addEventListener('click', () => {
    const student = state.participants.find((p) => p.id === button.dataset.packet);
    const room = state.rooms.find((candidate) => candidate.id === student?.roomId);
    const suffix = room?.status === 'voided' ? 'decision-record' : 'coaching-packet';
    download(`/api/instructor/export/${button.dataset.packet}`, `${(student?.name ?? 'student').toLowerCase().replace(/\s+/g, '-')}-${suffix}.md`);
  }));
}

/* ----- done ----- */
function renderDone() {
  const session = state.session;
  const voided = session.state === 'voided';
  const cancelledBeforeStart = voided && state.rooms.length === 0;
  const cancelledRooms = state.rooms.filter((room) => room.status === 'voided').length;
  const allTablesCancelled = !voided && state.rooms.length > 0 && cancelledRooms === state.rooms.length;
  const recordsHeading = cancelledBeforeStart ? '' : voided || allTablesCancelled ? 'Decision records' : cancelledRooms ? 'Student records' : 'Coaching packets';
  const heading = voided ? 'Activity cancelled.' : allTablesCancelled ? 'All tables cancelled.' : 'Activity complete.';
  const summary = cancelledBeforeStart
    ? 'Cancelled before starting. No game decisions were recorded.'
    : voided
      ? "This activity won't count. Decision records remain available below."
    : allTablesCancelled
      ? 'No table results will count. Decision records remain available below.'
      : cancelledRooms
        ? `${cancelledRooms} cancelled table${cancelledRooms === 1 ? '' : 's'} will not count. Student records remain available below.`
        : 'Students can download their coaching packets from their own screens — or hand them out from here.';
  const packetRows = state.participants.map((participant) => {
    const room = state.rooms.find((candidate) => candidate.id === participant.roomId);
    const packetReady = ['completed', 'voided'].includes(room?.status);
    if (!packetReady) return '';
    const recordLabel = voided || room?.status === 'voided' ? 'Decision record' : 'Packet';
    return `
    <div class="student-row">
      <span class="row atg-u-42157081b0"><b>${esc(participant.name)}</b><span class="faint atg-u-cdcef186c8">${room ? `Table ${tableNumber(room.id)}` : ''}</span></span>
      <button class="btn tiny quiet" data-packet="${participant.id}" ${packetReady ? '' : 'disabled'}>${recordLabel}</button>
    </div>`;
  }).join('');

  setMarkup($('#view'), `
  <div class="atg-u-822fbf3a98">
    <div class="stack atg-u-d56e3e3bc1">
      <span class="kicker">${esc(sessionLine(session))}</span>
      <h1 class="serif atg-u-6922544a4f">${heading}</h1>
      <p class="muted atg-u-38965f9b18">${summary}</p>
    </div>
    <div class="row wrap atg-u-84dfe8ad07">
      <button class="btn primary atg-u-ec10e38446" id="new-activity">Set up the next activity →</button>
      <button class="btn quiet atg-u-d870643db9" id="audit-export">Download instructor audit</button>
      <button class="btn quiet atg-u-d870643db9" id="audit-export-json">Download verifier JSON</button>
      <button class="btn danger atg-u-d870643db9" id="purge-archives">Purge records past retention date</button>
    </div>
    ${packetRows ? `
    <div class="stack atg-u-ed95c27e26">
      <span class="kicker">${recordsHeading}</span>
      <div class="stack atg-u-d56e3e3bc1">${packetRows}</div>
    </div>` : ''}
  </div>`);

  $('#new-activity').addEventListener('click', () => { showSetup = true; render(); });
  $('#audit-export').addEventListener('click', () => download('/api/instructor/audit-export', 'instructor-audit.md'));
  $('#audit-export-json').addEventListener('click', () => download('/api/instructor/audit-export.json', 'instructor-audit.json', 'application/json'));
  $('#purge-archives').addEventListener('click', () => requestRetentionPurge('#new-activity'));
  $$('[data-packet]').forEach((button) => button.addEventListener('click', () => {
    const student = state.participants.find((p) => p.id === button.dataset.packet);
    const room = state.rooms.find((candidate) => candidate.id === student?.roomId);
    const suffix = state.session?.state === 'voided' || room?.status === 'voided' ? 'decision-record' : 'coaching-packet';
    download(`/api/instructor/export/${button.dataset.packet}`, `${(student?.name ?? 'student').toLowerCase().replace(/\s+/g, '-')}-${suffix}.md`);
  }));
}

/* ----- projector ----- */
function openProjector() {
  const projector = $('#projector');
  if (projector.open) return;
  projectorReturnFocus = stableInstructorFocusSelector(document.activeElement, '#open-projector');
  projector.showModal();
  syncProjector();
  $('#projector-close').focus();
  const requestFullscreen = document.documentElement.requestFullscreen;
  projectorFullscreenRequested = Boolean(requestFullscreen);
  if (requestFullscreen) requestFullscreen.call(document.documentElement).then(() => {
    if (!projector.open || !projectorFullscreenRequested) document.exitFullscreen?.().catch(() => {});
  }).catch(() => { projectorFullscreenRequested = false; });
}
function closeProjector() {
  const projector = $('#projector');
  projectorFullscreenRequested = false;
  if (projector.open) projector.close();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  const focusTarget = $(projectorReturnFocus ?? '#open-projector') ?? $('#view');
  projectorReturnFocus = null;
  focusTarget?.focus?.({ preventScroll: true });
}
function syncProjector() {
  if (!$('#projector').open) return;
  const session = state?.session;
  if (!session || session.state !== 'lobby') { closeProjector(); return; }
  const urls = joinUrls();
  $('#projector-url').textContent = urls.length ? urls.join('\n') : 'Ask your professor for the address';
  $('#projector-url').classList.toggle('multiple', urls.length > 1);
  $('#projector-code').textContent = fmtCode(session.joinCode);
  $('#projector-count').textContent = state.participants.length;
}
$('#projector-close').addEventListener('click', closeProjector);
$('#projector').addEventListener('keydown', (event) => {
  trapDialogTab($('#projector'), event);
});
$('#projector').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeProjector();
});
document.addEventListener('fullscreenchange', () => {
  if ($('#projector').open && projectorFullscreenRequested && !document.fullscreenElement) closeProjector();
});

/* ---------- boot ---------- */
api('/api/instructor/state')
  .then((result) => { if (absorb(result)) render(); connect(); })
  .catch((error) => {
    setMarkup($('#view'), `<div class="card atg-u-0dbce3116f">
      <h2 class="serif atg-u-4b54da713d">This page only works on the classroom computer.</h2>
      <p class="muted">Open it on the machine running the server, at 127.0.0.1. (${esc(error.message)})</p>
    </div>`);
  });
