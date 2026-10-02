import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const instructorHtml = fs.readFileSync(new URL('../public/instructor.html', import.meta.url), 'utf8');
const studentHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const instructorJs = fs.readFileSync(new URL('../public/instructor.js', import.meta.url), 'utf8');
const studentJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

class FakeClassList {
  #names = new Set();

  add(...names) { names.forEach((name) => this.#names.add(name)); }
  remove(...names) { names.forEach((name) => this.#names.delete(name)); }
  contains(name) { return this.#names.has(name); }
  toggle(name, force) {
    const enabled = force ?? !this.contains(name);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(document, id = '') {
    this.ownerDocument = document;
    this.id = id;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.content = '';
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.isConnected = true;
    this.focusableElements = [];
    this.descendants = new Map();
    this._innerHTML = '';
    this.innerHTMLWrites = 0;
    this.open = false;
    this.textContent = '';
    this.value = '';
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.innerHTMLWrites += 1;
    this.onInnerHTMLWrite?.(this._innerHTML);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelectorAll() {
    return this.focusableElements.filter((element) => !element.disabled);
  }

  querySelector(selector) {
    if (!this.descendants.has(selector)) this.descendants.set(selector, new FakeElement(this.ownerDocument, selector));
    return this.descendants.get(selector);
  }

  contains(element) {
    return element === this || this.focusableElements.includes(element);
  }

  closest(selector) {
    return selector === '[hidden]' && this.hidden ? this : null;
  }

  getClientRects() {
    return this.hidden ? [] : [{}];
  }

  async emit(type, overrides = {}) {
    const event = {
      key: '',
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    const results = [];
    for (const listener of this.listeners.get(type) ?? []) results.push(listener(event));
    await Promise.all(results);
    return event;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  select() { this.selected = true; this.focus(); }
  focus() { this.focused = true; this.ownerDocument.activeElement = this; }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.fullscreenElement = null;
    this.listeners = new Map();
    this.elements = new Map();
    this.documentElement = new FakeElement(this, 'document-element');
    this.documentElement.requestFullscreen = async () => {
      this.fullscreenElement = this.documentElement;
    };
    this.exitFullscreen = async () => {
      this.fullscreenElement = null;
    };
  }

  querySelector(selector) {
    if (!this.elements.has(selector)) {
      const element = new FakeElement(this, selector);
      const dataAttribute = selector.match(/^\[data-([a-z-]+)="([^"]+)"\]$/);
      if (dataAttribute) {
        const property = dataAttribute[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        element.dataset[property] = dataAttribute[2];
      }
      this.elements.set(selector, element);
    }
    return this.elements.get(selector);
  }

  querySelectorAll() { return []; }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async emit(type, overrides = {}) {
    const event = {
      key: '',
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    const results = [];
    for (const listener of this.listeners.get(type) ?? []) results.push(listener(event));
    await Promise.all(results);
    return event;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(data = {}) {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    async json() { return data; },
  };
}

function detachedTimeout(...args) {
  const timer = setTimeout(...args);
  timer.unref();
  return timer;
}

function detachedInterval(...args) {
  const timer = setInterval(...args);
  timer.unref();
  return timer;
}

function createBaseContext(document, extras = {}) {
  return vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    document,
    location: { host: '127.0.0.1:3102', port: '3102', protocol: 'http:' },
    requestAnimationFrame: (callback) => callback(),
    setInterval: detachedInterval,
    setTimeout: detachedTimeout,
    URL,
    ...extras,
  });
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    api: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  };
}

class NoopEventSource {
  static CLOSED = 2;
  constructor() { this.readyState = 1; }
  addEventListener() {}
  close() { this.readyState = NoopEventSource.CLOSED; }
}

function createInstructorHarness({ fetch = async () => jsonResponse({}), EventSource = NoopEventSource } = {}) {
  const boot = instructorJs.indexOf('/* ---------- boot ---------- */');
  assert.notEqual(boot, -1, 'could not isolate instructor boot code');

  const document = new FakeDocument();
  document.querySelector('meta[name="csrf-token"]').content = 'test-csrf';
  const context = createBaseContext(document, {
    fetch,
    EventSource,
  });
  vm.runInContext(`
    ${instructorJs.slice(0, boot)}
    globalThis.__hooks = {
      openProjector,
      closeProjector,
      requestCancellation,
      closeCancellation,
      mutate,
      syncMutationControls,
      absorb,
      connect,
      render,
      renderSetup,
      renderLive,
      renderDone,
      setState(value) { state = value; },
      setStudentUrls(value) { studentUrls = value; },
      stateSnapshot() {
        return JSON.stringify({ revision: stateRevision, sessionState: state?.session?.state ?? null });
      },
      setSetup(value) {
        if (value.rounds) Object.assign(setup.rounds, value.rounds);
        for (const [key, item] of Object.entries(value)) if (key !== 'rounds') setup[key] = item;
      }
    };
  `, context);
  return { context, document };
}

function createProjectorHarness() {
  const { context, document } = createInstructorHarness();
  context.__hooks.setState({
    session: { state: 'lobby', joinCode: '123456' },
    participants: [{ id: 'student-1' }],
  });
  context.__hooks.setStudentUrls(['http://10.0.0.12:3102']);
  return { context, document };
}

function createStudentHarness({ fetch = async () => jsonResponse({}), initialStorage = {}, EventSource = NoopEventSource } = {}) {
  const boot = studentJs.lastIndexOf('\nrestore();');
  assert.notEqual(boot, -1, 'could not isolate student boot code');

  const document = new FakeDocument();
  const storage = createMemoryStorage(initialStorage);
  const context = createBaseContext(document, {
    crypto: { randomUUID: () => 'action-id' },
    fetch,
    localStorage: storage.api,
    EventSource,
    window: { innerWidth: 1280 },
  });
  vm.runInContext(`
    ${studentJs.slice(0, boot)}
    globalThis.__hooks = {
      render,
      renderJoin,
      renderReconnect,
      renderTrading,
      renderDone,
      restore,
      connect,
      act,
      acceptSnapshot,
      signOut,
      requestSignOut,
      closeStudentConfirmation,
      syncFormStateOwner,
      tradingActionFeedback,
      setIdentity(nextIdentity, nextSnapshot) {
        sessionActive = Boolean(nextIdentity);
        csrfToken = sessionActive ? 'test-csrf' : null;
        identityGeneration += 1;
        actionRequestGeneration += 1;
        actionInFlight = false;
        snapshot = nextSnapshot;
      },
      setSnapshot(value) { snapshot = value; },
      setForms(value) {
        if (value.order) Object.assign(orderForm, value.order);
        if (value.bid) Object.assign(bidForm, value.bid);
      },
      formSnapshot() { return JSON.stringify({ orderForm, bidForm, formStateOwner }); },
      identitySnapshot() {
        return JSON.stringify({
          sessionActive,
          participantId: snapshot?.participant?.id ?? null,
          participantName: snapshot?.participant?.name ?? null,
          revision: snapshotRevision,
          actionEpoch: snapshot?.actionEpoch ?? null
        });
      }
    };
  `, context);
  return { context, document, storage: storage.values };
}

function openingTag(html, attribute, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<[^>]+\\b${attribute}="${escaped}"[^>]*>`));
  assert.ok(match, `expected an element with ${attribute}="${value}"`);
  return match[0];
}

test('cancellation dialog locks duplicate submits and recovers after an inline error', async () => {
  const focusHelperStart = instructorJs.indexOf('function stableInstructorFocusSelector');
  const focusHelperEnd = instructorJs.indexOf('let toastTimer', focusHelperStart);
  const start = instructorJs.indexOf('function requestCancellation');
  const end = instructorJs.indexOf('async function download', start);
  assert.notEqual(focusHelperStart, -1, 'stable focus helper must remain available');
  assert.notEqual(focusHelperEnd, -1, 'could not isolate stable focus helper');
  assert.notEqual(start, -1, 'requestCancellation must remain available');
  assert.notEqual(end, -1, 'could not isolate the cancellation controller');

  const document = new FakeDocument();
  const requests = [];
  const attempts = [];
  const context = createBaseContext(document, {
    __select: (selector) => document.querySelector(selector),
    __mutate(path, body, options) {
      const attempt = deferred();
      requests.push({ path, body, options });
      attempts.push(attempt);
      return attempt.promise.then(({ success, message = 'Server rejected cancellation' }) => {
        if (!success) options.onError(message);
        return success;
      });
    },
  });
  vm.runInContext(`
    let pendingCancellation = null;
    let cancellationSubmitting = false;
    const $ = globalThis.__select;
    const mutate = (...args) => globalThis.__mutate(...args);
    ${instructorJs.slice(focusHelperStart, focusHelperEnd)}
    ${instructorJs.slice(start, end)}
    globalThis.__hooks = { requestCancellation, closeCancellation };
  `, context);

  const config = {
    path: '/api/instructor/room/room-7/void',
    title: 'Cancel Table 7?',
    description: 'This table will stop.',
    note: 'Technical issue',
    confirmLabel: 'Cancel Table 7',
  };
  context.__hooks.requestCancellation(config);

  const dialog = document.querySelector('#cancel-dialog');
  const form = document.querySelector('#cancel-form');
  const confirmButton = document.querySelector('#cancel-dialog-confirm');
  const closeButton = document.querySelector('#cancel-dialog-close');
  const note = document.querySelector('#cancel-note');
  const error = document.querySelector('#cancel-dialog-error');
  assert.equal(dialog.open, true);
  assert.equal(note.value, 'Technical issue');
  assert.equal(note.selected, true);

  note.value = '  Wi-Fi outage  ';
  const firstSubmit = form.emit('submit');
  const duplicateSubmit = form.emit('submit');
  assert.equal(requests.length, 1, 'a repeated submit must not send a second cancellation');
  assert.equal(requests[0].body.note, 'Wi-Fi outage');
  assert.equal(requests[0].path, config.path);
  assert.equal(confirmButton.disabled, true);
  assert.equal(closeButton.disabled, true);
  assert.equal(note.disabled, true);

  const escapeWhileSubmitting = await dialog.emit('cancel');
  assert.equal(escapeWhileSubmitting.defaultPrevented, true, 'Escape must not dismiss an in-flight cancellation');

  attempts[0].resolve({ success: false });
  await Promise.all([firstSubmit, duplicateSubmit]);
  assert.equal(dialog.open, true);
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Server rejected cancellation');
  assert.equal(confirmButton.disabled, false);
  assert.equal(closeButton.disabled, false);
  assert.equal(note.disabled, false);
  assert.equal(document.activeElement, note);

  const retrySubmit = form.emit('submit');
  assert.equal(requests.length, 2);
  attempts[1].resolve({ success: true });
  await retrySubmit;
  assert.equal(dialog.open, false, 'a successful cancellation must close the dialog');
});

test('leaving fullscreen closes the projector overlay on the first Escape', async () => {
  const { context, document } = createProjectorHarness();
  const projector = document.querySelector('#projector');

  context.__hooks.openProjector();
  await Promise.resolve();
  assert.equal(projector.classList.contains('show') || projector.open, true);

  document.fullscreenElement = null;
  await document.emit('fullscreenchange');
  assert.equal(
    projector.classList.contains('show') || projector.open,
    false,
    'the first Escape exits fullscreen; fullscreenchange must close the visible overlay too',
  );
});

test('the projector blocks interaction with the underlying instructor controls', async () => {
  const { context, document } = createProjectorHarness();
  const projector = document.querySelector('#projector');
  const view = document.querySelector('#view');

  context.__hooks.openProjector();
  await Promise.resolve();
  assert.equal(
    projector.open || view.inert || view.hasAttribute('inert'),
    true,
    'the projector must be a native modal dialog or make the underlying dashboard inert',
  );
});

test('instructor mutations are single-flight while a request is pending', async () => {
  const end = instructorJs.indexOf('function requestCancellation');
  assert.notEqual(end, -1, 'could not isolate the instructor mutation helper');

  const document = new FakeDocument();
  document.querySelector('meta[name="csrf-token"]').content = 'test-csrf';
  const calls = [];
  const pending = [];
  const context = createBaseContext(document, {
    fetch(...args) {
      const wait = deferred();
      calls.push(args);
      pending.push(wait);
      return wait.promise;
    },
  });
  vm.runInContext(`
    ${instructorJs.slice(0, end)}
    function absorb(value) { globalThis.__absorbed = value; }
    function render() { globalThis.__renders = (globalThis.__renders ?? 0) + 1; }
    globalThis.__mutate = mutate;
  `, context);

  const first = context.__mutate('/api/instructor/session/start');
  const duplicate = context.__mutate('/api/instructor/session/start');
  const callCount = calls.length;
  for (const wait of pending) wait.resolve(jsonResponse({ session: { state: 'running' } }));
  await Promise.all([first, duplicate]);

  assert.equal(callCount, 1, 'rapid repeated clicks must send only one instructor mutation');
});

test('a successful instructor mutation clears an earlier error toast completely', async () => {
  let attempts = 0;
  const nextState = {
    session: null,
    games: { rps: { defaultRounds: 30, minRounds: 10, maxRounds: 100 } },
    participants: [],
    rooms: [],
  };
  const { context, document } = createInstructorHarness({
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 409,
          async json() { return { error: 'The activity already changed' }; },
        };
      }
      return jsonResponse(nextState);
    },
  });

  assert.equal(await context.__hooks.mutate('/api/instructor/session/start'), false);
  const toastElement = document.querySelector('#toast');
  assert.equal(toastElement.classList.contains('show'), true);
  assert.equal(toastElement.textContent, 'The activity already changed');

  assert.equal(await context.__hooks.mutate('/api/instructor/session/start'), true);
  assert.equal(toastElement.classList.contains('show'), false, 'a successful save must dismiss a stale error');
  assert.equal(toastElement.textContent, '', 'a stale error must not remain exposed to assistive technology');
});

test('instructor mutation unlock preserves controls that were already semantically disabled', async () => {
  const wait = deferred();
  const { context, document } = createInstructorHarness({ fetch: () => wait.promise });
  const semanticDisabled = new FakeElement(document, 'start-with-empty-roster');
  semanticDisabled.disabled = true;
  const temporarilyLocked = new FakeElement(document, 'pause-enabled-session');
  document.querySelectorAll = () => [semanticDisabled, temporarilyLocked];

  const nextState = {
    session: null,
    games: { rps: { defaultRounds: 30, minRounds: 10, maxRounds: 100 } },
    participants: [],
    rooms: [],
  };
  const mutation = context.__hooks.mutate('/api/instructor/session/start');
  assert.equal(semanticDisabled.disabled, true);
  assert.equal(semanticDisabled.dataset.mutationLocked, undefined, 'pre-disabled controls must not be marked as lock-owned');
  assert.equal(temporarilyLocked.disabled, true);
  assert.equal(temporarilyLocked.dataset.mutationLocked, 'true');

  wait.resolve(jsonResponse(nextState));
  await mutation;
  assert.equal(semanticDisabled.disabled, true, 'unlock must not enable a control disabled by page semantics');
  assert.equal(semanticDisabled.dataset.mutationLocked, undefined);
  assert.equal(temporarilyLocked.disabled, false, 'a control disabled only by the request lock should unlock');
  assert.equal(temporarilyLocked.dataset.mutationLocked, undefined);
});

test('student actions are single-flight while a request is pending', async () => {
  const end = studentJs.indexOf('/* ---------- shared helpers ---------- */');
  assert.notEqual(end, -1, 'could not isolate the student action helper');

  const document = new FakeDocument();
  const calls = [];
  const pending = [];
  const storage = new Map();
  const context = createBaseContext(document, {
    crypto: { randomUUID: () => `action-${calls.length + 1}` },
    fetch(...args) {
      const wait = deferred();
      calls.push(args);
      pending.push(wait);
      return wait.promise;
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
    WebSocket: class {},
  });
  vm.runInContext(`
    ${studentJs.slice(0, end)}
    function render() { globalThis.__renders = (globalThis.__renders ?? 0) + 1; }
    globalThis.__act = act;
  `, context);

  const first = context.__act({ type: 'rock' });
  const duplicate = context.__act({ type: 'rock' });
  const callCount = calls.length;
  for (const wait of pending) wait.resolve(jsonResponse({ participant: { id: 'student-1' } }));
  await Promise.all([first, duplicate]);

  assert.equal(callCount, 1, 'a double-click must not submit two decisions or orders');
});

test('a successful non-trading action clears an earlier action-error toast', async () => {
  let attempts = 0;
  const snapshot = {
    participant: { id: 'student-1', name: 'Maya' },
    session: null,
    room: null,
    actionEpoch: 1,
    exportAvailable: false,
  };
  const { context, document } = createStudentHarness({
    initialStorage: { 'agentic-games-participant-token': 'student-token' },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 409,
          async json() { return { error: 'Not your turn' }; },
        };
      }
      return jsonResponse({ ...snapshot, actionEpoch: 2, actionResult: { type: 'accepted' } });
    },
  });
  context.__hooks.setIdentity('student-token', snapshot);

  assert.equal(await context.__hooks.act({ type: 'play', choice: 'rock' }), false);
  const toastElement = document.querySelector('#toast');
  assert.equal(toastElement.classList.contains('show'), true);
  assert.equal(toastElement.textContent, "Hold on — it's not your turn yet.");

  assert.equal(await context.__hooks.act({ type: 'play', choice: 'paper' }), true);
  assert.equal(toastElement.classList.contains('show'), false, 'the accepted move must dismiss the stale error');
  assert.equal(toastElement.textContent, '');
});

test('reconnect-screen student switching requires the shared confirmation dialog', async () => {
  const tokenKey = 'agentic-games-participant-token';
  const { context, document, storage } = createStudentHarness({
    initialStorage: { [tokenKey]: 'student-token' },
  });
  context.__hooks.setIdentity('student-token', null);
  context.__hooks.renderReconnect();

  const switchButton = document.querySelector('#leave-reconnect');
  switchButton.id = 'leave-reconnect';
  switchButton.focus();
  await switchButton.emit('click');

  assert.equal(document.querySelector('#student-confirm-dialog').open, true);
  assert.equal(storage.get(tokenKey), 'student-token', 'opening the confirmation must not sign the student out');
  assert.equal(document.querySelector('#student-confirm-title').textContent, 'Switch students?');

  context.__hooks.closeStudentConfirmation();
  assert.equal(storage.get(tokenKey), 'student-token');
  assert.equal(document.activeElement, switchButton, 'dismissal must restore focus to the reconnect-screen trigger');
});

test('modal dialogs keep forward and reverse tab focus inside the active surface', async () => {
  {
    const { context, document } = createStudentHarness();
    context.__hooks.requestSignOut();
    const dialog = document.querySelector('#student-confirm-dialog');
    const surface = dialog.querySelector('[data-dialog-surface]');
    const closeButton = document.querySelector('#student-confirm-close');
    const confirmButton = document.querySelector('#student-confirm-submit');
    dialog.focusableElements = [closeButton, confirmButton];

    confirmButton.focus();
    const forward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(forward.defaultPrevented, true);
    assert.equal(document.activeElement, closeButton, 'forward Tab must wrap to the first student-dialog control');

    closeButton.focus();
    const reverse = await dialog.emit('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(reverse.defaultPrevented, true);
    assert.equal(document.activeElement, confirmButton, 'reverse Tab must wrap to the last student-dialog control');

    surface.focus();
    const surfaceForward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(surfaceForward.defaultPrevented, true);
    assert.equal(document.activeElement, closeButton, 'forward Tab from the student-dialog surface must remain inside');

    surface.focus();
    const surfaceReverse = await dialog.emit('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(surfaceReverse.defaultPrevented, true);
    assert.equal(document.activeElement, confirmButton, 'reverse Tab from the dialog surface must remain inside');
  }

  {
    const { context, document } = createInstructorHarness();
    context.__hooks.requestCancellation({
      path: '/api/instructor/session/void',
      title: 'Cancel this activity?',
      description: 'This stops every table.',
      confirmLabel: 'Cancel activity',
    });
    const dialog = document.querySelector('#cancel-dialog');
    const surface = dialog.querySelector('[data-dialog-surface]');
    const note = document.querySelector('#cancel-note');
    const closeButton = document.querySelector('#cancel-dialog-close');
    const confirmButton = document.querySelector('#cancel-dialog-confirm');
    dialog.focusableElements = [note, closeButton, confirmButton];

    confirmButton.focus();
    const forward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(forward.defaultPrevented, true);
    assert.equal(document.activeElement, note, 'instructor dialog must wrap from confirm to its reason field');

    note.focus();
    const reverse = await dialog.emit('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(reverse.defaultPrevented, true);
    assert.equal(document.activeElement, confirmButton, 'instructor dialog must reverse-wrap to confirm');

    surface.focus();
    const surfaceForward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(surfaceForward.defaultPrevented, true);
    assert.equal(document.activeElement, note, 'forward Tab from the instructor-dialog surface must remain inside');

    surface.focus();
    const surfaceReverse = await dialog.emit('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(surfaceReverse.defaultPrevented, true);
    assert.equal(document.activeElement, confirmButton, 'reverse Tab from the instructor-dialog surface must remain inside');

    note.disabled = true;
    closeButton.disabled = true;
    confirmButton.disabled = true;
    const noControls = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(noControls.defaultPrevented, true, 'an in-flight dialog must not release focus into browser chrome');
    assert.equal(document.activeElement, surface, 'an in-flight dialog must fall back to its valid inner surface');
  }

  {
    const { context, document } = createProjectorHarness();
    context.__hooks.openProjector();
    const dialog = document.querySelector('#projector');
    const surface = dialog.querySelector('[data-dialog-surface]');
    const closeButton = document.querySelector('#projector-close');
    dialog.focusableElements = [closeButton];
    closeButton.focus();
    const forward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(forward.defaultPrevented, true);
    assert.equal(document.activeElement, closeButton, 'projector focus must remain on its only control');

    surface.focus();
    const surfaceForward = await dialog.emit('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(surfaceForward.defaultPrevented, true);
    assert.equal(document.activeElement, closeButton, 'forward Tab from the projector surface must reach its control');

    surface.focus();
    const surfaceReverse = await dialog.emit('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(surfaceReverse.defaultPrevented, true);
    assert.equal(document.activeElement, closeButton, 'reverse Tab from the projector surface must reach its control');
  }
});

test('a rejected post-join token remounts a usable join screen', async () => {
  const paths = [];
  const { context, document, storage } = createStudentHarness({
    fetch: async (path) => {
      paths.push(path);
      if (path === '/api/join') return jsonResponse({ token: 'short-lived-token' });
      if (path === '/api/me') {
        return {
          ok: false,
          status: 401,
          async json() { return { error: 'Invalid participant token' }; },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });

  const screen = document.querySelector('#screen');
  context.__hooks.renderJoin();
  assert.equal(screen.innerHTMLWrites, 1);
  document.querySelector('#join-code').value = '123456';
  document.querySelector('#student-name').value = 'Maya';
  await document.querySelector('#join-form').emit('submit');

  assert.deepEqual(paths, ['/api/join', '/api/me']);
  assert.equal(storage.has('agentic-games-participant-token'), false);
  assert.equal(screen.innerHTMLWrites, 2, 'token rejection must remount the join form even when it was already the current screen');
  assert.match(screen.innerHTML, /Join your class/);
  assert.match(screen.innerHTML, />Join session<\/button>/);
});

test('a successful join clears an earlier join-error toast before restore completes', async () => {
  const restoreResponse = deferred();
  let joinAttempts = 0;
  const { context, document } = createStudentHarness({
    fetch: async (path) => {
      if (path === '/api/join') {
        joinAttempts += 1;
        if (joinAttempts === 1) {
          return {
            ok: false,
            status: 400,
            async json() { return { error: 'Invalid join code' }; },
          };
        }
        return jsonResponse({ token: 'valid-token' });
      }
      if (path === '/api/me') return restoreResponse.promise;
      throw new Error(`Unexpected request: ${path}`);
    },
  });

  context.__hooks.renderJoin();
  document.querySelector('#join-code').value = '111111';
  document.querySelector('#student-name').value = 'Maya';
  await document.querySelector('#join-form').emit('submit');

  const toastElement = document.querySelector('#toast');
  assert.equal(toastElement.classList.contains('show'), true);
  assert.equal(toastElement.textContent, "That code didn't match. Double-check it with your professor.");

  document.querySelector('#join-code').value = '123456';
  const successfulJoin = document.querySelector('#join-form').emit('submit');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(toastElement.classList.contains('show'), false, 'the stale error must not remain visible after authentication succeeds');
  assert.equal(toastElement.textContent, '', 'the stale error must not remain exposed to assistive technology');

  restoreResponse.resolve(jsonResponse({
    participant: { id: 'student-1', name: 'Maya' },
    session: null,
    room: null,
  }));
  await successfulJoin;
});

test('a stale cookie-session restore cannot overwrite a newer identity restore', async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const calls = [];
  const { context } = createStudentHarness({
    fetch(path) {
      calls.push(path);
      if (path !== '/api/me') throw new Error(`Unexpected request: ${path}`);
      return calls.length === 1 ? oldResponse.promise : newResponse.promise;
    },
  });

  context.__hooks.setIdentity('old-cookie-session', null);
  const oldRestore = context.__hooks.restore();
  context.__hooks.setIdentity('new-cookie-session', null);
  const newRestore = context.__hooks.restore();
  assert.deepEqual(calls, ['/api/me', '/api/me']);

  newResponse.resolve(jsonResponse({
    participant: { id: 'new-student', name: 'New Student' },
    session: null,
    room: null,
    csrfToken: 'new-csrf',
  }));
  await newRestore;
  oldResponse.resolve(jsonResponse({
    participant: { id: 'old-student', name: 'Old Student' },
    session: null,
    room: null,
    csrfToken: 'old-csrf',
  }));
  await oldRestore;

  assert.deepEqual(JSON.parse(context.__hooks.identitySnapshot()), {
    sessionActive: true,
    participantId: 'new-student',
    participantName: 'New Student',
    revision: null,
    actionEpoch: null,
  }, 'the late response for the prior server-side session must be ignored');
});

test('lower-revision HTTP responses cannot replace newer student or instructor snapshots', async () => {
  {
    const httpResponse = deferred();
    const { context } = createInstructorHarness({ fetch: () => httpResponse.promise });
    const stateAt = (revision, sessionState = null) => ({
      revision,
      session: sessionState ? {
        id: 'session-a', state: sessionState, game: 'rps', mode: 'live', config: { rounds: 10 }, joinCode: '123456'
      } : null,
      games: { rps: { defaultRounds: 30, minRounds: 10, maxRounds: 100 } },
      participants: [],
      rooms: [],
    });
    context.__hooks.absorb(stateAt(10));
    const mutation = context.__hooks.mutate('/api/instructor/session/start');
    context.__hooks.absorb(stateAt(12));
    httpResponse.resolve(jsonResponse(stateAt(11, 'voided')));
    await mutation;
    assert.deepEqual(JSON.parse(context.__hooks.stateSnapshot()), { revision: 12, sessionState: null });
  }

  {
    const httpResponse = deferred();
    const { context } = createStudentHarness({ fetch: () => httpResponse.promise });
    const snapshotAt = (revision, name, actionEpoch) => ({
      revision,
      participant: { id: 'student-a', name },
      session: null,
      room: null,
      actionEpoch,
      exportAvailable: false,
    });
    context.__hooks.setIdentity('cookie-session', snapshotAt(10, 'Initial Student', 0));
    context.__hooks.acceptSnapshot(snapshotAt(10, 'Initial Student', 0));
    const action = context.__hooks.act({ type: 'play', choice: 'rock' });
    context.__hooks.acceptSnapshot(snapshotAt(12, 'SSE Student', 4));
    httpResponse.resolve(jsonResponse({
      ...snapshotAt(11, 'Stale HTTP Student', 1),
      actionResult: { type: 'accepted' },
    }));
    await action;
    assert.deepEqual(JSON.parse(context.__hooks.identitySnapshot()), {
      sessionActive: true,
      participantId: 'student-a',
      participantName: 'SSE Student',
      revision: 12,
      actionEpoch: 4,
    });
  }
});

test('an old-identity action response is ignored and cannot clear the new identity action lock', async () => {
  const oldActionResponse = deferred();
  const newActionResponse = deferred();
  const calls = [];
  const snapshotFor = (identityLabel, revision, actionEpoch) => ({
    revision,
    participant: { id: `${identityLabel}-student`, name: `${identityLabel} Student` },
    session: null,
    room: null,
    actionEpoch,
    exportAvailable: false,
  });
  const { context } = createStudentHarness({
    fetch(path) {
      calls.push(path);
      if (path !== '/api/action') throw new Error(`Unexpected request: ${path}`);
      return calls.length === 1 ? oldActionResponse.promise : newActionResponse.promise;
    },
  });
  context.__hooks.setIdentity('old-cookie-session', snapshotFor('old', 10, 0));
  context.__hooks.acceptSnapshot(snapshotFor('old', 10, 0));
  const oldAction = context.__hooks.act({ type: 'play', choice: 'rock' });

  context.__hooks.setIdentity('new-cookie-session', snapshotFor('new', 20, 0));
  context.__hooks.acceptSnapshot(snapshotFor('new', 20, 0));
  const newAction = context.__hooks.act({ type: 'play', choice: 'paper' });
  assert.equal(calls.filter((path) => path === '/api/action').length, 2);

  oldActionResponse.resolve(jsonResponse({
    ...snapshotFor('old', 99, 1),
    actionResult: { type: 'accepted' },
  }));
  assert.equal(await oldAction, false);
  assert.deepEqual(JSON.parse(context.__hooks.identitySnapshot()), {
    sessionActive: true,
    participantId: 'new-student',
    participantName: 'new Student',
    revision: 20,
    actionEpoch: 0,
  });

  const blockedThirdAction = await context.__hooks.act({ type: 'play', choice: 'scissors' });
  assert.equal(blockedThirdAction, false, 'the old response must not clear the newer request lock');
  assert.equal(calls.filter((path) => path === '/api/action').length, 2);

  newActionResponse.resolve(jsonResponse({
    ...snapshotFor('new', 21, 1),
    actionResult: { type: 'accepted' },
  }));
  assert.equal(await newAction, true);
  assert.deepEqual(JSON.parse(context.__hooks.identitySnapshot()), {
    sessionActive: true,
    participantId: 'new-student',
    participantName: 'new Student',
    revision: 21,
    actionEpoch: 1,
  });
});

test('SSE rerenders restore equivalent enabled controls without stealing modal focus', () => {
  const streams = [];
  class FakeEventSource {
    static CLOSED = 2;
    constructor() { this.readyState = 1; this.listeners = new Map(); streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = FakeEventSource.CLOSED; }
  }

  {
    const { context, document } = createInstructorHarness({ EventSource: FakeEventSource });
    const instructorState = (revision) => ({
      revision,
      session: { id: 'session-a', state: 'lobby', game: 'rps', mode: 'live', config: { rounds: 10 }, joinCode: '123456' },
      games: { rps: { defaultRounds: 30, minRounds: 10, maxRounds: 100 } },
      participants: [{ id: 'student-a', name: 'Maya', connected: true }],
      rooms: [],
    });
    context.__hooks.absorb(instructorState(1));
    context.__hooks.connect();
    const instructorStream = streams.at(-1);
    const oldStart = new FakeElement(document, 'start');
    oldStart.focus();
    const newStart = new FakeElement(document, 'start');
    document.querySelector('#view').onInnerHTMLWrite = () => {
      oldStart.isConnected = false;
      document.elements.set('#start', newStart);
    };
    instructorStream.emit('health', instructorState(2));
    assert.equal(document.activeElement, newStart);

    const modalControl = document.querySelector('#cancel-dialog-close');
    document.querySelector('#cancel-dialog').showModal();
    modalControl.focus();
    instructorStream.emit('health', instructorState(3));
    assert.equal(document.activeElement, modalControl, 'instructor rerender must not pull focus out of an open modal');
  }

  {
    const { context, document } = createStudentHarness({ EventSource: FakeEventSource });
    const studentState = (revision) => ({
      revision,
      participant: { id: 'student-a', name: 'Maya' },
      session: { id: 'session-a', state: 'lobby', game: 'rps', mode: 'live', config: { rounds: 10 } },
      room: null,
      actionEpoch: 0,
      exportAvailable: false,
    });
    context.__hooks.setIdentity('cookie-session', studentState(1));
    context.__hooks.acceptSnapshot(studentState(1));
    context.__hooks.connect();
    const studentStream = streams.at(-1);
    const oldSwitch = new FakeElement(document);
    oldSwitch.classList.add('switch-student');
    oldSwitch.focus();
    const newSwitch = new FakeElement(document);
    newSwitch.classList.add('switch-student');
    document.querySelector('#screen').onInnerHTMLWrite = () => {
      oldSwitch.isConnected = false;
      document.elements.set('.switch-student', newSwitch);
    };
    studentStream.emit('room_update', studentState(2));
    assert.equal(document.activeElement, newSwitch);

    const modalControl = document.querySelector('#student-confirm-close');
    document.querySelector('#student-confirm-dialog').showModal();
    modalControl.focus();
    studentStream.emit('room_update', studentState(3));
    assert.equal(document.activeElement, modalControl, 'student rerender must not pull focus out of an open modal');
  }
});

test('closing the projector before fullscreen resolves exits a late fullscreen immediately', async () => {
  const { context, document } = createProjectorHarness();
  const fullscreenRequest = deferred();
  let exitCalls = 0;
  document.documentElement.requestFullscreen = () => fullscreenRequest.promise;
  document.exitFullscreen = async () => {
    exitCalls += 1;
    document.fullscreenElement = null;
  };

  context.__hooks.openProjector();
  context.__hooks.closeProjector();
  assert.equal(document.querySelector('#projector').open, false);
  document.fullscreenElement = document.documentElement;
  fullscreenRequest.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exitCalls, 1);
  assert.equal(document.fullscreenElement, null);
});

test('game form state persists for one owner and resets across rooms, sessions, and students', () => {
  const { context } = createStudentHarness();
  const identity = (participantId, sessionId, roomId) => ({
    participant: { id: participantId },
    session: { id: sessionId },
    room: { id: roomId },
  });
  const forms = () => JSON.parse(context.__hooks.formSnapshot());

  context.__hooks.setIdentity('token-a', identity('student-a', 'session-a', 'room-a'));
  context.__hooks.syncFormStateOwner();
  context.__hooks.setForms({
    order: { side: 'sell', type: 'market', price: 212, qty: 5 },
    bid: { qty: 7, face: 6, key: 'round-7' },
  });
  context.__hooks.syncFormStateOwner();
  assert.equal(forms().orderForm.side, 'sell', 'ordinary rerenders must preserve the active owner\'s form');
  assert.equal(forms().bidForm.face, 6);

  context.__hooks.setIdentity('token-a', identity('student-a', 'session-a', 'room-b'));
  context.__hooks.syncFormStateOwner();
  assert.deepEqual(forms().orderForm, { side: 'buy', type: 'limit', price: null, qty: 1 });
  assert.deepEqual(forms().bidForm, { qty: 1, face: 2, key: null });

  context.__hooks.setForms({ order: { side: 'sell', qty: 4 }, bid: { face: 5 } });
  context.__hooks.setIdentity('token-a', identity('student-a', 'session-b', 'room-c'));
  context.__hooks.syncFormStateOwner();
  assert.equal(forms().orderForm.side, 'buy', 'a new session must not inherit the previous session\'s order');
  assert.equal(forms().bidForm.face, 2);

  context.__hooks.setForms({ order: { price: 249 }, bid: { qty: 9 } });
  context.__hooks.setIdentity('token-b', identity('student-b', 'session-b', 'room-c'));
  context.__hooks.syncFormStateOwner();
  assert.equal(forms().orderForm.price, null, 'a different student must receive fresh form defaults');
  assert.equal(forms().bidForm.qty, 1);
});

test('trading explains a no-fill market order and disables order cancellation whenever play is blocked', () => {
  const { context, document } = createStudentHarness();
  const market = {
    status: 'running',
    secondsRemaining: 60,
    yourSignal: 101,
    bids: [],
    asks: [],
    recentTrades: [],
    yourOrders: [{ id: 17, side: 'buy', remaining: 2, price: 99 }],
    yourCash: 1000,
    yourInventory: 5,
    yourAvailableBuyQuantity: 5,
    yourAvailableSellQuantity: 5,
  };
  const snapshot = (sessionState, room = {}) => ({
    participant: { id: 'student-a', name: 'Maya' },
    session: { id: 'session-a', state: sessionState },
    room: { id: 'room-a', unhealthy: false, seatControlledByBot: false, ...room },
  });
  const cancelButton = () => document.querySelector('[data-order-id="17"]');

  assert.equal(
    context.__hooks.tradingActionFeedback({
      type: 'order_accepted',
      filledQuantity: 0,
      restingQuantity: 0,
      cancelledQuantity: 3,
    }),
    'No matching order was available, so nothing filled.',
  );

  context.__hooks.setSnapshot(snapshot('running'));
  context.__hooks.renderTrading(market);
  assert.equal(cancelButton().disabled, false, 'Cancel should remain available during healthy, active gameplay');

  const blocked = [
    ['paused session', snapshot('paused')],
    ['unhealthy room', snapshot('running', { unhealthy: true })],
    ['bot-controlled seat', snapshot('running', { seatControlledByBot: true })],
  ];
  for (const [label, blockedSnapshot] of blocked) {
    context.__hooks.setSnapshot(blockedSnapshot);
    context.__hooks.renderTrading(market);
    assert.equal(cancelButton().disabled, true, `Cancel must be disabled for a ${label}`);
  }
});

test('recurring trading snapshots keep order controls attached while live market panels update', async () => {
  const requests = [];
  let responseRevision = 20;
  let latestMarket;
  const studentSnapshot = (state, actionEpoch = 0) => ({
    revision: responseRevision,
    actionEpoch,
    participant: { id: 'student-a', name: 'Maya' },
    session: { id: 'session-a', state: 'running' },
    room: {
      id: 'room-a', status: 'running', unhealthy: false, seatControlledByBot: false,
      state,
    },
  });
  const { context, document } = createStudentHarness({
    initialStorage: { 'agentic-games-participant-token': 'token-a' },
    fetch: async (_path, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      responseRevision += 1;
      const result = body.action.type === 'cancel'
        ? { type: 'order_cancelled', cancelledQuantity: 2 }
        : { type: 'order_accepted', filledQuantity: 0, restingQuantity: 5, cancelledQuantity: 0 };
      return jsonResponse({ ...studentSnapshot(latestMarket, requests.length), actionResult: result });
    },
  });

  const market = {
    game: 'trading', status: 'running', secondsRemaining: 60, yourSignal: 101,
    bids: [], asks: [], recentTrades: [],
    yourOrders: [{ id: 17, side: 'buy', remaining: 2, price: 99 }],
    yourCash: 1000, yourInventory: 0,
    yourAvailableBuyQuantity: 8, yourAvailableSellQuantity: 10,
  };
  latestMarket = market;
  context.__hooks.setIdentity('token-a', studentSnapshot(market));
  context.__hooks.setForms({ order: { side: 'sell', type: 'limit', price: 250, qty: 5 } });
  context.__hooks.renderTrading(market);

  const screen = document.querySelector('#screen');
  const submit = document.querySelector('#submit-order');
  const cancel = document.querySelector('[data-order-id="17"]');
  const orders = document.querySelector('#trading-orders');
  const screenWrites = screen.innerHTMLWrites;
  const orderWrites = orders.innerHTMLWrites;

  latestMarket = {
    ...market,
    secondsRemaining: 58,
    yourCash: 975,
    bids: [{ id: 44, side: 'buy', price: 102, remaining: 3 }],
    recentTrades: [{ price: 101, quantity: 1 }],
  };
  context.__hooks.setSnapshot(studentSnapshot(latestMarket));
  context.__hooks.renderTrading(latestMarket);

  assert.equal(screen.innerHTMLWrites, screenWrites, 'a market tick must not replace the trading screen');
  assert.equal(orders.innerHTMLWrites, orderWrites, 'unchanged open orders must keep their cancel controls attached');
  assert.equal(document.querySelector('#submit-order'), submit);
  assert.equal(document.querySelector('[data-order-id="17"]'), cancel);
  assert.equal(submit.listeners.get('click')?.length, 1, 'the stable submit control must retain one listener');
  assert.equal(cancel.listeners.get('click')?.length, 1, 'the stable cancel control must retain one listener');
  assert.match(document.querySelector('#trading-position').innerHTML, /975\.00/, 'position data must still refresh');
  assert.match(document.querySelector('#trading-book').innerHTML, />102</, 'order-book data must still refresh');
  assert.equal(document.querySelector('#clock').textContent, '0:58', 'the server clock must still refresh');

  await submit.emit('click');
  assert.deepEqual(requests[0].action, { type: 'limit', side: 'sell', quantity: 5, price: 250 });
  await cancel.emit('click');
  assert.deepEqual(requests[1].action, { type: 'cancel', orderId: 17 });
});

test('setup exposes pressed selections and disables the length control at both boundaries', () => {
  const { context, document } = createInstructorHarness();
  context.__hooks.setState({
    session: null,
    games: {
      rps: { defaultRounds: 30, minRounds: 10, maxRounds: 100 },
    },
  });
  context.__hooks.setSetup({ game: 'rps', mode: 'live', rounds: { rps: 10 } });
  context.__hooks.renderSetup();

  let html = document.querySelector('#view').innerHTML;
  assert.match(openingTag(html, 'data-game', 'rps'), /aria-pressed="true"/);
  assert.match(openingTag(html, 'data-game', 'blackjack'), /aria-pressed="false"/);
  assert.match(openingTag(html, 'data-mode', 'live'), /aria-pressed="true"/);
  assert.match(openingTag(html, 'data-mode', 'random'), /aria-pressed="false"/);
  assert.match(openingTag(html, 'id', 'len-down'), /\bdisabled\b/);
  assert.doesNotMatch(openingTag(html, 'id', 'len-up'), /\bdisabled\b/);

  context.__hooks.setSetup({ rounds: { rps: 100 } });
  context.__hooks.renderSetup();
  html = document.querySelector('#view').innerHTML;
  assert.doesNotMatch(openingTag(html, 'id', 'len-down'), /\bdisabled\b/);
  assert.match(openingTag(html, 'id', 'len-up'), /\bdisabled\b/);
});

test('paused disconnected seats can get a bot, but seat restoration requires reconnection', () => {
  const { context, document } = createInstructorHarness();
  const stateFor = ({ connected, botFilling }) => ({
    session: { id: 'session-a', state: 'paused', game: 'rps', mode: 'live', config: { rounds: 30 } },
    participants: [{ id: 'student-a', name: 'Maya', connected, roomId: 'room-a' }],
    rooms: [{
      id: 'room-a',
      status: 'running',
      unhealthy: false,
      progress: '1/30',
      players: [{ id: 'student-a', name: 'Maya', isBot: botFilling }],
    }],
    health: { connected: connected ? 1 : 0, total: 1 },
  });
  const view = document.querySelector('#view');

  context.__hooks.setState(stateFor({ connected: false, botFilling: false }));
  context.__hooks.renderLive();
  assert.match(view.innerHTML, /data-replace="student-a"/i, 'paused instructors must be able to fill an away seat');
  assert.doesNotMatch(view.innerHTML, /data-restore="student-a"/i);

  context.__hooks.setState(stateFor({ connected: false, botFilling: true }));
  context.__hooks.renderLive();
  assert.doesNotMatch(view.innerHTML, /data-restore="student-a"/i);
  assert.match(view.innerHTML, /Reconnect to take back the seat/);

  context.__hooks.setState(stateFor({ connected: true, botFilling: true }));
  context.__hooks.renderLive();
  assert.match(view.innerHTML, /data-restore="student-a"/i, 'only a reconnected student may receive the seat back');
});

test('cancelling from the lobby reports no decisions and renders no bogus packet rows', () => {
  const { context, document } = createInstructorHarness();
  context.__hooks.setState({
    session: {
      id: 'session-a',
      state: 'voided',
      game: 'rps',
      mode: 'live',
      config: { rounds: 30 },
    },
    participants: [{ id: 'student-a', name: 'Maya', roomId: null }],
    rooms: [],
  });
  context.__hooks.renderDone();

  const html = document.querySelector('#view').innerHTML;
  assert.match(html, /Activity cancelled\./);
  assert.match(html, /Cancelled before starting\. No game decisions were recorded\./);
  assert.doesNotMatch(html, /data-packet=/, 'students without a completed or cancelled room must not get an export row');
  assert.doesNotMatch(html, /Decision records|Coaching packets/);
});

test('an all-cancelled activity offers decision records but no class summary', () => {
  const { context, document } = createInstructorHarness();
  context.__hooks.setState({
    session: {
      id: 'session-a',
      state: 'completed',
      game: 'rps',
      mode: 'live',
      config: { rounds: 30 },
    },
    participants: [{ id: 'student-a', name: 'Maya', roomId: 'room-a' }],
    rooms: [{
      id: 'room-a',
      status: 'voided',
      players: [{ id: 'student-a', name: 'Maya', isBot: false }],
    }],
  });
  context.__hooks.renderDone();

  const html = document.querySelector('#view').innerHTML;
  assert.match(html, /All tables cancelled\./);
  assert.match(html, /data-packet="student-a"/);
  assert.doesNotMatch(html, /id="class-export"/, 'a wholly cancelled activity has no valid class summary');
});

test('modal focus recovery targets current DOM nodes instead of detached triggers', () => {
  {
    const { context, document } = createInstructorHarness();
    const oldTrigger = new FakeElement(document, 'old-remove-button');
    oldTrigger.focus();
    context.__hooks.requestCancellation({
      path: '/api/instructor/participant/student-a/remove',
      title: 'Remove Maya?',
      description: 'Remove this student.',
      confirmLabel: 'Remove student',
      showNote: false,
      focusAfter: '#roster-heading',
    });
    oldTrigger.isConnected = false;
    const currentRosterHeading = new FakeElement(document, 'current-roster-heading');
    document.elements.set('#roster-heading', currentRosterHeading);
    context.__hooks.closeCancellation({ focusResult: true });
    assert.equal(document.activeElement, currentRosterHeading, 'post-mutation focus must resolve the current selector after rerender');
  }

  {
    const { context, document } = createProjectorHarness();
    const oldProjectorTrigger = new FakeElement(document, 'old-projector-trigger');
    oldProjectorTrigger.focus();
    context.__hooks.openProjector();
    oldProjectorTrigger.isConnected = false;
    const currentProjectorTrigger = new FakeElement(document, 'current-projector-trigger');
    document.elements.set('#old-projector-trigger', currentProjectorTrigger);
    context.__hooks.closeProjector();
    assert.equal(document.activeElement, currentProjectorTrigger, 'projector close must resolve a current trigger instead of retaining the old node');
  }

  {
    const { context, document } = createStudentHarness();
    const oldSwitchTrigger = new FakeElement(document, 'old-switch-trigger');
    oldSwitchTrigger.classList.add('switch-student');
    oldSwitchTrigger.focus();
    context.__hooks.requestSignOut();
    oldSwitchTrigger.isConnected = false;
    const currentSwitchTrigger = new FakeElement(document, 'current-switch-trigger');
    document.elements.set('.switch-student', currentSwitchTrigger);
    context.__hooks.closeStudentConfirmation();
    assert.equal(document.activeElement, currentSwitchTrigger, 'student modal close must resolve the rerendered Switch control');
  }
});

test('a student whose lobby was cancelled sees no-decision copy and no decision record', () => {
  const { context, document } = createStudentHarness({
    initialStorage: { 'agentic-games-participant-token': 'student-token' },
  });
  context.__hooks.setIdentity('student-token', {
    revision: 4,
    participant: { id: 'student-a', name: 'Maya' },
    session: { id: 'session-a', state: 'voided', game: 'rps', mode: 'live', config: { rounds: 10 } },
    room: null,
    actionEpoch: 0,
    exportAvailable: false,
  });
  context.__hooks.renderDone(true);

  const html = document.querySelector('#screen').innerHTML;
  assert.match(html, /cancelled this activity before play began/i);
  assert.match(html, /no game decisions were recorded/i);
  assert.doesNotMatch(html, /decision record/i);
  assert.doesNotMatch(html, /download-packet/);
});

test('a student sees a nonterminal preparing screen while cancellation is still finalizing', () => {
  const { context, document } = createStudentHarness({
    initialStorage: { 'agentic-games-participant-token': 'student-token' },
  });
  context.__hooks.setIdentity('student-token', {
    revision: 4,
    participant: { id: 'student-a', name: 'Maya' },
    session: { id: 'session-a', state: 'voiding', game: 'rps', mode: 'live', config: { rounds: 10 } },
    room: { id: 'room-a', status: 'voided', state: { game: 'rps', status: 'completed', players: [] } },
    actionEpoch: 0,
    exportAvailable: false,
  });
  context.__hooks.render();

  const html = document.querySelector('#screen').innerHTML;
  assert.match(html, /Cancelling this activity/i);
  assert.match(html, /preparing any decision records/i);
  assert.doesNotMatch(html, /leave-device|download-packet|no game decisions were recorded/i,
    'the transient snapshot must not expose terminal actions or premature record claims');
});

test('the whole student screen is not an aria-live region', () => {
  const screen = openingTag(studentHtml, 'id', 'screen');
  assert.doesNotMatch(screen, /\baria-live\b/i);
  assert.match(screen, /\btabindex="-1"/i);
});

test('native dialogs put programmatic focus on valid inner surfaces', () => {
  const cases = [
    [studentHtml, 'student-confirm-dialog', openingTag(studentHtml, 'id', 'student-confirm-form')],
    [instructorHtml, 'cancel-dialog', openingTag(instructorHtml, 'id', 'cancel-form')],
    [instructorHtml, 'projector', openingTag(instructorHtml, 'class', 'projector-dialog-surface')],
  ];

  for (const [html, dialogId, surface] of cases) {
    const dialog = openingTag(html, 'id', dialogId);
    assert.doesNotMatch(dialog, /\btabindex\b/i, `${dialogId} must not use tabindex on <dialog>`);
    assert.match(surface, /\bdata-dialog-surface\b/i, `${dialogId} needs a marked inner focus surface`);
    assert.match(surface, /\btabindex="-1"/i, `${dialogId}'s inner surface must accept programmatic focus`);
  }
});

test('destructive frontend choices do not use browser-native confirm dialogs', () => {
  const nativeConfirm = /(?:^|[^\w$.])(?:window\.)?confirm\s*\(/m;
  assert.equal(nativeConfirm.test(instructorJs), false, 'instructor choices must use accessible in-page confirmation UI');
  assert.equal(nativeConfirm.test(studentJs), false, 'student switching/sign-out must use accessible in-page confirmation UI');
  assert.match(instructorHtml, /<dialog\b/i, 'the instructor page must retain in-page modal confirmation');
});
