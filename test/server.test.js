import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createApplication, isLoopback } from '../src/server.js';

function cookieFrom(response, name) {
  const header = response.headers.get('set-cookie') ?? '';
  const value = header.split(';')[0];
  assert.match(value, new RegExp(`^${name}=`));
  return value;
}

function csrfFrom(html) {
  const match = html.match(/name="csrf-token" content="([A-Za-z0-9_-]+)"/);
  assert.ok(match, 'expected a CSRF token in the instructor page');
  return match[1];
}

async function startApplication(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-secure-http-'));
  const app = createApplication({
    databasePath: path.join(directory, 'test.sqlite'),
    encryptionKey: crypto.randomBytes(32),
    errorLogger: () => {},
    ...options,
  });
  app.studentServer.listen(0, '127.0.0.1');
  app.instructorServer.listen(0, '127.0.0.1');
  await Promise.all([once(app.studentServer, 'listening'), once(app.instructorServer, 'listening')]);
  return {
    app,
    directory,
    studentOrigin: `http://127.0.0.1:${app.studentServer.address().port}`,
    instructorOrigin: `http://127.0.0.1:${app.instructorServer.address().port}`,
    async close() {
      await app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function bootstrapInstructor(context) {
  const response = await fetch(context.app.instructorBootstrapUrl(), { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/instructor');
  const cookie = cookieFrom(response, 'atg_instructor_session');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/i);
  const page = await fetch(`${context.instructorOrigin}/instructor`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const csrf = csrfFrom(await page.text());
  return {
    cookie,
    csrf,
    headers: { cookie, origin: context.instructorOrigin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
  };
}

async function createSession(context, instructor, roster = [{ identity: 'student-001', name: 'Student One' }]) {
  const response = await fetch(`${context.instructorOrigin}/api/instructor/session`, {
    method: 'POST',
    headers: instructor.headers,
    body: JSON.stringify({ game: 'rps', mode: 'random', rounds: 10, roster }),
  });
  if (response.status !== 201) assert.fail(`session creation returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function joinStudent(context, invitation, joinCode) {
  const response = await fetch(`${context.studentOrigin}/api/join`, {
    method: 'POST',
    headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ joinCode, inviteCode: invitation.inviteCode }),
  });
  if (response.status !== 201) assert.fail(`student join returned ${response.status}: ${await response.text()}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const authCookie = setCookie.match(/(?:^|,\s*)(atg_student_session=[^;,]+)/)?.[1];
  const csrfCookie = setCookie.match(/(?:^|,\s*)(atg_student_csrf=[^;,]+)/)?.[1];
  assert.ok(authCookie && csrfCookie, 'join must issue both the HttpOnly session and readable CSRF cookies');
  const cookie = `${authCookie}; ${csrfCookie}`;
  const body = await response.json();
  assert.equal(Object.hasOwn(body, 'token'), false, 'platform bearer tokens must never reach the browser');
  assert.equal(typeof body.csrfToken, 'string');
  return {
    body,
    cookie,
    headers: { cookie, origin: context.studentOrigin, 'x-csrf-token': body.csrfToken, 'content-type': 'application/json' },
  };
}

const sseReaders = new WeakMap();

async function readSseEvent(reader, timeoutMilliseconds = 2_000) {
  let state = sseReaders.get(reader);
  if (!state) {
    state = { decoder: new TextDecoder(), buffered: '' };
    sseReaders.set(reader, state);
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const boundary = state.buffered.indexOf('\n\n');
    if (boundary >= 0) {
      const block = state.buffered.slice(0, boundary);
      state.buffered = state.buffered.slice(boundary + 2);
      if (block.startsWith(':')) continue;
      const event = block.match(/^event: (.+)$/m)?.[1] ?? 'message';
      const data = block.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out waiting for SSE event');
    let timer;
    let result;
    try {
      result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for SSE event')), remaining); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (result.done) {
      state.buffered += state.decoder.decode();
      if (!state.buffered.includes('\n\n')) return null;
    } else {
      state.buffered += state.decoder.decode(result.value, { stream: true });
    }
  }
}

async function rawStatus(target, hostHeader, headers = {}) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { ...headers, host: hostHeader },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('SSE test reader preserves later events in the same chunk', async () => {
  const bytes = new TextEncoder().encode('event: snapshot\ndata: {"step":1}\n\n: keep-alive\n\nevent: update\ndata: {"step":2}\n\n');
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).getReader();
  assert.deepEqual(await readSseEvent(reader), { event: 'snapshot', data: { step: 1 } });
  assert.deepEqual(await readSseEvent(reader), { event: 'update', data: { step: 2 } });
  assert.equal(await readSseEvent(reader), null);
});

test('loopback recognition is deliberately narrow', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback('10.0.0.2'), false);
});

test('non-loopback student listeners require explicit HTTPS configuration', () => {
  assert.throws(() => createApplication({ studentHost: '0.0.0.0' }), /cannot be a wildcard/);
  assert.throws(() => createApplication({ studentHost: '::' }), /cannot be a wildcard/);
  assert.throws(() => createApplication({ studentHost: '0:0:0:0:0:0:0:0' }), /cannot be a wildcard/);
  assert.throws(() => createApplication({ studentHost: '::1' }), /explicit IPv4/);
  assert.throws(() => createApplication({ studentHost: 'localhost' }), /explicit IPv4/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20' }), /TLS key and certificate are required/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', studentPublicOrigin: 'https://classroom.example', tls: {} }), /explicit key and certificate/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x', minVersion: 'TLSv1' } }), /TLS minVersion/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', tls: { key: 'x', cert: 'x' } }), /studentPublicOrigin is required/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x' } }), /studentAllowedCidr is required/);
  assert.throws(() => createApplication({ studentHost: '203.0.113.20', studentAllowedCidr: '203.0.113.0/24', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x' } }), /RFC1918 private/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', studentAllowedCidr: '0.0.0.0/0', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x' } }), /stay entirely/);
  assert.throws(() => createApplication({ studentHost: '172.20.1.20', studentAllowedCidr: '172.0.0.0/8', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x' } }), /stay entirely/);
  assert.throws(() => createApplication({ studentHost: '192.168.1.20', studentAllowedCidr: '10.0.0.0/8', studentPublicOrigin: 'https://classroom.example', tls: { key: 'x', cert: 'x' } }), /studentHost must belong/);
  assert.throws(() => createApplication({ studentPublicOrigin: 'https://127.0.0.1', studentHost: '127.0.0.1' }), /must use http/);
});

test('application server handles cannot be rebound to broader interfaces', async () => {
  const app = createApplication({ databasePath: ':memory:', encryptionKey: crypto.randomBytes(32) });
  try {
    assert.throws(() => app.studentServer.listen(0, '0.0.0.0'), /Student listener must bind explicitly/);
    assert.throws(() => app.studentServer.listen({ port: 0, host: '::' }), /Student listener must bind explicitly/);
    assert.throws(() => app.instructorServer.listen(0, '0.0.0.0'), /Instructor listener must bind explicitly/);
  } finally {
    await app.close();
  }
});

test('student and instructor listeners are isolated, hardened, and expose minimal health', async () => {
  const context = await startApplication();
  try {
    const health = await fetch(`${context.studentOrigin}/api/health`);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(health.headers.get('content-security-policy'), /unsafe-inline/);
    assert.match(health.headers.get('content-security-policy'), /style-src-attr 'none'/);
    assert.match(health.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(health.headers.has('strict-transport-security'), false, 'HSTS is emitted by the HTTPS listener only');

    assert.equal((await fetch(`${context.studentOrigin}/instructor`)).status, 404);
    assert.equal((await fetch(`${context.instructorOrigin}/`)).status, 404);
    assert.equal((await fetch(`${context.instructorOrigin}/instructor`)).status, 401, 'loopback alone must not grant control access');
  } finally {
    await context.close();
  }
});

test('canonical Host enforcement defeats rebinding without consuming bootstrap capability', async () => {
  const context = await startApplication();
  try {
    const hostile = await rawStatus(context.app.instructorBootstrapUrl(), 'attacker.example');
    assert.equal(hostile.status, 421);
    assert.equal(Boolean(hostile.headers['set-cookie']), false);

    const instructor = await bootstrapInstructor(context);
    const replay = await fetch(context.app.instructorBootstrapUrl(), { redirect: 'manual' });
    assert.equal(replay.status, 401, 'the bootstrap capability must be single-use');

    const hostileControlHost = await rawStatus(`${context.instructorOrigin}/api/instructor/state`, 'attacker.example', {
      cookie: instructor.cookie,
      'x-csrf-token': instructor.csrf,
    });
    assert.equal(hostileControlHost.status, 421);

    const hostileStudentHost = await rawStatus(`${context.studentOrigin}/api/health`, 'attacker.example');
    assert.equal(hostileStudentHost.status, 421);
  } finally {
    await context.close();
  }
});

test('instructor and student cookie mutations require exact Origin and CSRF', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const sessionBody = { game: 'rps', mode: 'random', rounds: 10, roster: [{ identity: 's1', name: 'Maya' }] };
    for (const headers of [
      { cookie: instructor.cookie, origin: 'http://attacker.example', 'x-csrf-token': instructor.csrf, 'content-type': 'application/json' },
      { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': 'wrong', 'content-type': 'application/json' },
      { cookie: instructor.cookie, 'x-csrf-token': instructor.csrf, 'content-type': 'application/json' },
    ]) {
      const response = await fetch(`${context.instructorOrigin}/api/instructor/session`, { method: 'POST', headers, body: JSON.stringify(sessionBody) });
      assert.equal(response.status, 403);
    }

    const created = await createSession(context, instructor, sessionBody.roster);
    assert.equal(created.invitations.length, 1);
    const invitation = created.invitations[0];
    const hostileJoin = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST',
      headers: { origin: 'http://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, inviteCode: invitation.inviteCode }),
    });
    assert.equal(hostileJoin.status, 403);

    const student = await joinStudent(context, invitation, created.session.joinCode);
    const me = await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).participant.name, 'Maya');

    const started = await fetch(`${context.instructorOrigin}/api/instructor/session/start`, { method: 'POST', headers: instructor.headers, body: '{}' });
    assert.equal(started.status, 200);
    const snapshot = await (await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } })).json();
    const action = { actionId: 'secure-action-1', actionEpoch: snapshot.actionEpoch, action: { type: 'play', choice: 'rock' } };
    for (const headers of [
      { cookie: student.cookie, origin: 'http://attacker.example', 'x-csrf-token': student.body.csrfToken, 'content-type': 'application/json' },
      { cookie: student.cookie, origin: context.studentOrigin, 'x-csrf-token': 'wrong', 'content-type': 'application/json' },
    ]) {
      const response = await fetch(`${context.studentOrigin}/api/action`, { method: 'POST', headers, body: JSON.stringify(action) });
      assert.equal(response.status, 403);
    }
    const accepted = await fetch(`${context.studentOrigin}/api/action`, { method: 'POST', headers: student.headers, body: JSON.stringify(action) });
    if (accepted.status !== 200) assert.fail(`action returned ${accepted.status}: ${await accepted.text()}`);
  } finally {
    await context.close();
  }
});

test('admission accepts only a one-time roster invitation and never returns an auth token', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor, [{ identity: 'id-7', name: 'Jordan' }]);
    const invitation = created.invitations[0];

    const legacy = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, name: 'Alias' }),
    });
    assert.equal(legacy.status, 400);

    const student = await joinStudent(context, invitation, created.session.joinCode);
    assert.match(student.cookie, /^atg_student_session=/);
    assert.doesNotMatch(JSON.stringify(student.body), /student_[A-Za-z0-9_-]+/);

    const replay = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, inviteCode: invitation.inviteCode }),
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /invalid|used/i);
  } finally {
    await context.close();
  }
});

test('admission rolls back invite redemption when its web session cannot be persisted', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor, [{ identity: 'retry-1', name: 'Retry Student' }]);
    const invitation = created.invitations[0];
    const createWebSession = context.app.db.createStudentWebSession.bind(context.app.db);
    let injectFailure = true;
    context.app.db.createStudentWebSession = (record) => {
      if (injectFailure) {
        injectFailure = false;
        throw new Error('injected web-session persistence failure');
      }
      return createWebSession(record);
    };

    const failed = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, inviteCode: invitation.inviteCode }),
    });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error, 'Internal server error');

    const retried = await joinStudent(context, invitation, created.session.joinCode);
    assert.equal(retried.body.participant.name, 'Retry Student');
  } finally {
    await context.close();
  }
});

test('unused roster invitations can be rotated or revoked without revealing stored secrets', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor, [
      { identity: 'id-a', name: 'Maya' },
      { identity: 'id-b', name: 'Jordan' },
    ]);
    const firstEntry = created.roster.find((entry) => entry.identity === 'id-a');
    const secondEntry = created.roster.find((entry) => entry.identity === 'id-b');
    const oldFirst = created.invitations.find((entry) => entry.identity === 'id-a');
    const oldSecond = created.invitations.find((entry) => entry.identity === 'id-b');

    const rotatedResponse = await fetch(`${context.instructorOrigin}/api/instructor/roster/${firstEntry.id}/rotate`, {
      method: 'POST', headers: instructor.headers, body: '{}',
    });
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json();
    assert.equal(rotated.invitations.length, 1);
    assert.notEqual(rotated.invitations[0].inviteCode, oldFirst.inviteCode);

    const oldJoin = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, inviteCode: oldFirst.inviteCode }),
    });
    assert.equal(oldJoin.status, 400);
    await joinStudent(context, rotated.invitations[0], created.session.joinCode);

    const revokedResponse = await fetch(`${context.instructorOrigin}/api/instructor/roster/${secondEntry.id}/revoke`, {
      method: 'POST', headers: instructor.headers, body: '{}',
    });
    assert.equal(revokedResponse.status, 200);
    const revoked = await revokedResponse.json();
    assert.equal(revoked.revokedInvitationIdentity, 'id-b');
    assert.equal(Object.hasOwn(revoked.roster.find((entry) => entry.identity === 'id-b'), 'inviteCode'), false);

    const revokedJoin = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: created.session.joinCode, inviteCode: oldSecond.inviteCode }),
    });
    assert.equal(revokedJoin.status, 400);
  } finally {
    await context.close();
  }
});

test('voided activities retain a downloadable instructor-only canonical audit', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    await createSession(context, instructor);
    const unauthenticated = await fetch(`${context.instructorOrigin}/api/instructor/audit-export.json`, {
      headers: { origin: context.instructorOrigin },
    });
    assert.equal(unauthenticated.status, 401);
    const premature = await fetch(`${context.instructorOrigin}/api/instructor/audit-export.json`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': instructor.csrf },
    });
    assert.equal(premature.status, 409);
    const voided = await fetch(`${context.instructorOrigin}/api/instructor/session/void`, {
      method: 'POST', headers: instructor.headers, body: JSON.stringify({ note: 'Security test' }),
    });
    assert.equal(voided.status, 200);
    const audit = await fetch(`${context.instructorOrigin}/api/instructor/audit-export`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': instructor.csrf },
    });
    assert.equal(audit.status, 200);
    assert.equal(audit.headers.get('content-disposition'), 'attachment; filename="instructor-audit.md"');
    assert.match(await audit.text(), /Instructor Class Audit/);
    const verifier = await fetch(`${context.instructorOrigin}/api/instructor/audit-export.json`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': instructor.csrf },
    });
    assert.equal(verifier.status, 200);
    assert.match(verifier.headers.get('content-type'), /^application\/json/);
    assert.equal(verifier.headers.get('content-disposition'), 'attachment; filename="instructor-audit.json"');
    assert.equal(typeof (await verifier.json()), 'object');
  } finally {
    await context.close();
  }
});

test('retention purge requires explicit confirmation and invokes the narrow platform hook', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    let calls = 0;
    context.app.platform.purgeExpiredData = () => {
      calls += 1;
      return { sessions: 2 };
    };
    const rejected = await fetch(`${context.instructorOrigin}/api/instructor/purge`, {
      method: 'POST', headers: instructor.headers, body: JSON.stringify({ confirmation: 'yes' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(calls, 0);

    const accepted = await fetch(`${context.instructorOrigin}/api/instructor/purge`, {
      method: 'POST', headers: instructor.headers, body: JSON.stringify({ confirmation: 'PURGE ARCHIVED DATA' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual((await accepted.json()).purge, { sessions: 2 });
  } finally {
    await context.close();
  }
});

test('bounded SSE replaces WebSockets, pushes updates, and permits one live stream per student', async () => {
  const context = await startApplication();
  const controllers = [];
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);

    const missingBrowserContext = await fetch(`${context.studentOrigin}/api/events`, {
      headers: { cookie: student.cookie },
    });
    assert.equal(missingBrowserContext.status, 403);
    const contradictoryBrowserContext = await fetch(`${context.studentOrigin}/api/events`, {
      headers: {
        cookie: student.cookie,
        origin: 'http://attacker.example',
        referer: `${context.studentOrigin}/`,
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(contradictoryBrowserContext.status, 403);

    const firstController = new AbortController();
    controllers.push(firstController);
    const first = await fetch(`${context.studentOrigin}/api/events`, {
      headers: { cookie: student.cookie, referer: `${context.studentOrigin}/`, 'sec-fetch-site': 'same-origin' },
      signal: firstController.signal,
    });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type'), /^text\/event-stream/);
    const firstReader = first.body.getReader();
    const initial = await readSseEvent(firstReader);
    assert.equal(initial.event, 'snapshot');
    assert.equal(initial.data.participant.id, student.body.participant.id);

    const secondController = new AbortController();
    controllers.push(secondController);
    const second = await fetch(`${context.studentOrigin}/api/events`, {
      headers: { cookie: student.cookie, origin: context.studentOrigin }, signal: secondController.signal,
    });
    assert.equal(second.status, 200);
    const secondReader = second.body.getReader();
    assert.equal((await readSseEvent(secondReader)).event, 'snapshot');
    await assert.rejects(firstReader.read(), /terminated|aborted|closed/i,
      'a replacement stream must destroy the prior socket for that identity');

    const started = await fetch(`${context.instructorOrigin}/api/instructor/session/start`, { method: 'POST', headers: instructor.headers, body: '{}' });
    assert.equal(started.status, 200);
    const update = await readSseEvent(secondReader);
    assert.equal(update.data.session.state, 'running');

    const websocketAttempt = await fetch(`${context.studentOrigin}/ws`);
    assert.equal(websocketAttempt.status, 404);
  } finally {
    for (const controller of controllers) controller.abort();
    await context.close();
  }
});

test('instructor SSE requires exact Origin and distributes control state', async () => {
  const context = await startApplication();
  const controller = new AbortController();
  try {
    const instructor = await bootstrapInstructor(context);
    const hostile = await fetch(`${context.instructorOrigin}/api/instructor/events`, {
      headers: { cookie: instructor.cookie, origin: 'http://attacker.example' },
    });
    assert.equal(hostile.status, 403);

    const events = await fetch(`${context.instructorOrigin}/api/instructor/events`, {
      headers: { cookie: instructor.cookie, referer: `${context.instructorOrigin}/instructor`, 'sec-fetch-site': 'same-origin' },
      signal: controller.signal,
    });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    assert.equal((await readSseEvent(reader)).data.session, null);
    const created = await createSession(context, instructor);
    const update = await readSseEvent(reader);
    assert.equal(update.data.session.id, created.session.id);
  } finally {
    controller.abort();
    await context.close();
  }
});

test('instructor SSE remains connected at the supported maximum projection size', async () => {
  const context = await startApplication();
  const controller = new AbortController();
  try {
    const instructor = await bootstrapInstructor(context);
    const roster = Array.from({ length: 150 }, (_, index) => ({
      identity: `large-${String(index).padStart(3, '0')}`,
      name: `Student ${String(index).padStart(3, '0')}`,
    }));
    const create = await fetch(`${context.instructorOrigin}/api/instructor/session`, {
      method: 'POST', headers: instructor.headers,
      body: JSON.stringify({ game: 'liars_dice', mode: 'random', rounds: 3, roster }),
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    for (const invitation of created.invitations) {
      context.app.platform.join({ joinCode: created.session.joinCode, inviteCode: invitation.inviteCode });
    }
    await context.app.platform.startSession();

    const events = await fetch(`${context.instructorOrigin}/api/instructor/events`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin }, signal: controller.signal,
    });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    const initial = await readSseEvent(reader, 5_000);
    assert.equal(initial.data.participants.length, 150);
    assert.equal(initial.data.rooms.length, 150);
    context.app.platform.broadcastInstructor();
    const update = await readSseEvent(reader, 5_000);
    assert.equal(update.data.participants.length, 150, 'backpressure must not close a valid maximum-size stream');
  } finally {
    controller.abort();
    await context.close();
  }
});

test('inactive identities cannot open live streams or act as historical sessions', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    context.app.platform.participants.delete(student.body.participant.id);
    const stream = await fetch(`${context.studentOrigin}/api/events`, { headers: { cookie: student.cookie, origin: context.studentOrigin } });
    assert.equal(stream.status, 409);
    const snapshot = await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } });
    assert.equal(snapshot.status, 401);
  } finally {
    await context.close();
  }
});

test('terminal snapshots remain available over HTTP but cannot open historical streams', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    const voided = await fetch(`${context.instructorOrigin}/api/instructor/session/void`, {
      method: 'POST', headers: instructor.headers, body: JSON.stringify({ note: 'End the exercise' }),
    });
    assert.equal(voided.status, 200);

    const snapshot = await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).session.state, 'voided');
    const stream = await fetch(`${context.studentOrigin}/api/events`, {
      headers: { cookie: student.cookie, origin: context.studentOrigin },
    });
    assert.equal(stream.status, 409);
  } finally {
    await context.close();
  }
});

test('route-specific body limits and pre-queue rate limits reject abuse', async () => {
  const context = await startApplication();
  try {
    const oversizedJoin = await fetch(`${context.studentOrigin}/api/join`, {
      method: 'POST', headers: { origin: context.studentOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ joinCode: '123456', inviteCode: `invite_${'a'.repeat(2_000)}` }),
    });
    assert.equal(oversizedJoin.status, 413);

    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    const oversizedStart = await fetch(`${context.instructorOrigin}/api/instructor/session/start`, {
      method: 'POST', headers: instructor.headers, body: JSON.stringify({ padding: 'x'.repeat(200) }),
    });
    assert.equal(oversizedStart.status, 413);
    assert.equal(context.app.platform.session.state, 'lobby');
    const started = await fetch(`${context.instructorOrigin}/api/instructor/session/start`, { method: 'POST', headers: instructor.headers, body: '{}' });
    assert.equal(started.status, 200);

    const oversizedAction = await fetch(`${context.studentOrigin}/api/action`, {
      method: 'POST', headers: student.headers,
      body: JSON.stringify({ actionId: 'large', actionEpoch: 0, action: { type: 'play', choice: 'rock', padding: 'x'.repeat(5_000) } }),
    });
    assert.equal(oversizedAction.status, 413);

    let rateLimited = false;
    for (let index = 0; index < 16; index += 1) {
      const response = await fetch(`${context.studentOrigin}/api/action`, {
        method: 'POST', headers: student.headers,
        body: JSON.stringify({ actionId: `invalid-${index}`, actionEpoch: 0, action: { type: 'invalid' } }),
      });
      if (response.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.equal(rateLimited, true, 'identity limiter must reject before unbounded room-queue growth');
  } finally {
    await context.close();
  }
});

test('one abusive address cannot spend another student address request budget', async () => {
  const frozenTime = Date.now();
  const context = await startApplication({ now: () => frozenTime });
  try {
    context.app.studentServer.prependListener('request', (request) => {
      const address = request.headers['x-test-client-address'];
      if (address) Object.defineProperty(request.socket, 'remoteAddress', { value: address, configurable: true });
    });
    let rejected = 0;
    for (let index = 0; index < 125; index += 1) {
      const response = await fetch(`${context.studentOrigin}/api/health`, {
        headers: { 'x-test-client-address': '10.20.30.40' },
      });
      if (response.status === 429) rejected += 1;
      await response.arrayBuffer();
    }
    assert.equal(rejected, 5);
    const otherStudent = await fetch(`${context.studentOrigin}/api/health`, {
      headers: { 'x-test-client-address': '10.20.30.41' },
    });
    assert.equal(otherStudent.status, 200);
  } finally {
    await context.close();
  }
});

test('unexpected server exceptions return a generic response', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    context.app.platform.createSession = () => { throw new Error('/private/database/path.sqlite failed'); };
    const response = await fetch(`${context.instructorOrigin}/api/instructor/session`, {
      method: 'POST', headers: instructor.headers,
      body: JSON.stringify({ game: 'rps', mode: 'random', rounds: 10, roster: [{ identity: 's', name: 'S' }] }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, 'Internal server error');
    assert.match(body.incidentId, /^[0-9a-f-]{36}$/);

    context.app.platform.createSession = () => { throw new Error('Invalid encrypted sessions.config_json value'); };
    const misleadingPrefix = await fetch(`${context.instructorOrigin}/api/instructor/session`, {
      method: 'POST', headers: instructor.headers,
      body: JSON.stringify({ game: 'rps', mode: 'random', rounds: 10, roster: [{ identity: 's', name: 'S' }] }),
    });
    assert.equal(misleadingPrefix.status, 500);
    assert.equal((await misleadingPrefix.json()).error, 'Internal server error');
  } finally {
    await context.close();
  }
});

test('an unhealthy table returns a fixed conflict without logging its diagnostic', async () => {
  let logged = 0;
  const context = await startApplication({ errorLogger: () => { logged += 1; } });
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    await fetch(`${context.instructorOrigin}/api/instructor/session/start`, {
      method: 'POST', headers: instructor.headers, body: '{}',
    });
    const participant = context.app.platform.participants.get(student.body.participant.id);
    const room = context.app.platform.rooms.get(participant.roomId);
    room.unhealthy = 'sensitive internal engine diagnostic';
    room.status = 'unhealthy';
    const snapshot = await (await fetch(`${context.studentOrigin}/api/me`, {
      headers: { cookie: student.cookie },
    })).json();
    const response = await fetch(`${context.studentOrigin}/api/action`, {
      method: 'POST', headers: student.headers,
      body: JSON.stringify({ actionId: 'unhealthy-table', actionEpoch: snapshot.actionEpoch, action: { type: 'play', choice: 'rock' } }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'Table is unavailable; instructor review is required');
    assert.doesNotMatch(JSON.stringify(body), /sensitive|engine/i);
    assert.equal(logged, 0);
  } finally {
    await context.close();
  }
});

test('logout revokes the server-side student session and clears the cookie', async () => {
  const context = await startApplication();
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    const logout = await fetch(`${context.studentOrigin}/api/logout`, { method: 'POST', headers: student.headers, body: '{}' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } })).status, 401);
  } finally {
    await context.close();
  }
});

test('fixed class-day sessions cover long activities but cannot outlive twelve hours', async () => {
  let currentTime = Date.now();
  const context = await startApplication({ now: () => currentTime });
  try {
    const instructor = await bootstrapInstructor(context);
    const created = await createSession(context, instructor);
    const student = await joinStudent(context, created.invitations[0], created.session.joinCode);
    currentTime += 4 * 60 * 60 * 1000;
    assert.equal((await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } })).status, 200);
    assert.equal((await fetch(`${context.instructorOrigin}/api/instructor/state`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': instructor.csrf },
    })).status, 200);

    currentTime += 8 * 60 * 60 * 1000 + 1;
    assert.equal((await fetch(`${context.studentOrigin}/api/me`, { headers: { cookie: student.cookie } })).status, 401);
    assert.equal((await fetch(`${context.instructorOrigin}/api/instructor/state`, {
      headers: { cookie: instructor.cookie, origin: context.instructorOrigin, 'x-csrf-token': instructor.csrf },
    })).status, 401);
  } finally {
    await context.close();
  }
});

test('a consumed invitation still reconnects its student after a controlled server restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-session-restart-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const encryptionKey = crypto.randomBytes(32);
  let first = createApplication({ databasePath, encryptionKey });
  let second;
  try {
    first.studentServer.listen(0, '127.0.0.1');
    first.instructorServer.listen(0, '127.0.0.1');
    await Promise.all([once(first.studentServer, 'listening'), once(first.instructorServer, 'listening')]);
    const firstContext = {
      app: first,
      studentOrigin: `http://127.0.0.1:${first.studentServer.address().port}`,
      instructorOrigin: `http://127.0.0.1:${first.instructorServer.address().port}`,
    };
    const instructor = await bootstrapInstructor(firstContext);
    const created = await createSession(firstContext, instructor);
    const student = await joinStudent(firstContext, created.invitations[0], created.session.joinCode);
    const participantId = student.body.participant.id;
    await first.close();
    first = null;

    second = createApplication({ databasePath, encryptionKey });
    second.studentServer.listen(0, '127.0.0.1');
    second.instructorServer.listen(0, '127.0.0.1');
    await Promise.all([once(second.studentServer, 'listening'), once(second.instructorServer, 'listening')]);
    const origin = `http://127.0.0.1:${second.studentServer.address().port}`;
    const restored = await fetch(`${origin}/api/me`, { headers: { cookie: student.cookie } });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).participant.id, participantId);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
