import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../src/db.js';
import { GameActionError } from '../src/games.js';
import { Platform } from '../src/platform.js';
import { verifyAudit } from '../scripts/verify-audit.mjs';

let testRosterSequence = 0;

function withTestRoster(platform) {
  const redeem = platform.join.bind(platform);
  platform.join = (input, options) => {
    if (!Object.hasOwn(input, 'name')) return redeem(input, options);
    const [invitation] = platform.addRosterEntries([{
      identity: `test-identity-${++testRosterSequence}`,
      name: input.name,
    }]);
    return redeem({ joinCode: input.joinCode, inviteCode: invitation.inviteCode }, options);
  };
  return platform;
}

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-games-'));
  const filename = path.join(directory, 'test.sqlite');
  const db = new Database(filename);
  const platform = withTestRoster(new Platform(db));
  return {
    directory, filename, db, platform,
    close() {
      platform.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function clone(value) {
  return structuredClone(value);
}

function canonicalAuditJson(value) {
  const normalize = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value));
}

function rechainAuditEvents(audit) {
  let previousHash = '0'.repeat(64);
  const lastRoomHash = new Map();
  for (const event of audit.events) {
    event.previousHash = previousHash;
    const canonical = canonicalAuditJson({
      actor_id: event.actorId ?? null,
      created_at: event.createdAt,
      payload: event.payload,
      room_id: event.roomId ?? null,
      sequence: event.sequence ?? null,
      session_id: audit.session.id,
      type: event.type,
      visibility: event.visibility,
    });
    event.eventHash = crypto.createHash('sha256').update(previousHash).update('\n').update(canonical).digest('hex');
    previousHash = event.eventHash;
    if (event.roomId) lastRoomHash.set(event.roomId, event.eventHash);
  }
  audit.eventChain.root = previousHash;
  audit.eventChain.count = audit.events.length;
  for (const room of audit.rooms) room.transcriptRoot = lastRoomHash.get(room.id);
  for (const result of audit.resultProvenance) result.transcriptRoot = lastRoomHash.get(result.roomId);
}

function roomMemory(room) {
  return clone({
    state: room.engine.serialize(), rngCounter: room.rng.counter, status: room.status,
    sequence: room.sequence, unhealthy: room.unhealthy, actionIds: [...room.actionIds].sort(),
    actionEpochs: [...room.actionEpochs.entries()].sort(), players: room.players
  });
}

function withoutTradingClock(state) {
  const { endsAt: _endsAt, remainingMs: _remainingMs, ...rest } = clone(state);
  return rest;
}

function verifyExport(db, audit) {
  return verifyAudit(audit, { trustedPublicKey: db.auditPublicKey() });
}

test('platform runs an auditable student-vs-bot match and exports a bounded coaching packet', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: '<Alex>\n' });
    assert.equal(joined.participant.name, 'Alex');
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(participant, `move-${round}`, { type: 'play', choice: 'rock' });
    }
    assert.equal(h.platform.session.state, 'completed');
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 10);
    const packet = h.platform.exportMarkdown(participant.id);
    assert.match(packet, /Personalized Game-Theory Coaching Packet/);
    assert.match(packet, /Separate decision quality from realized outcome/);
    assert.match(packet, /Implemented rules and benchmark boundary/);
    assert.match(packet, /switchRate/);
    assert.doesNotMatch(packet, /Revealed seed|\bseed\s*:\s*[0-9a-f]{64}/i);
    assert.match(packet, /Seed commitment: [0-9a-f]{64}/);
    assert.doesNotMatch(packet, /OPENAI_API_KEY|api credits/i);
    const audit = h.platform.classAudit();
    assert.equal(audit.session.config.auditTopologyVersion, 'seating-v3');
    assert.equal(audit.events.find((event) => event.type === 'session_created')
      .payload.config.auditTopologyVersion, 'seating-v3');
    for (const type of ['seating_draw_committed', 'room_created', 'seating_draw_revealed']) {
      assert.equal(audit.events.find((event) => event.type === type).payload.topologyVersion, 'seating-v3');
    }
    assert.equal(verifyExport(h.db, audit).root, audit.eventChain.root);
    assert.throws(() => verifyAudit(audit), /separately trusted audit public key/);
    const room = h.platform.rooms.get(participant.roomId);
    const provenance = h.db.resultProvenance(h.platform.session.id, room.id);
    assert.equal(provenance.length, room.players.length);
    assert.equal(provenance.find((entry) => entry.player_id === participant.id).competitive_eligible, 1);
    assert.equal(provenance.every((entry) => entry.transcript_root === room.transcriptRoot), true);
    const tampered = structuredClone(audit);
    tampered.events.find((event) => event.roomId).payload = { tampered: true };
    assert.throws(() => verifyExport(h.db, tampered), /hash does not verify/);
    const prototypeTampered = JSON.parse(JSON.stringify(audit));
    Object.defineProperty(prototypeTampered.events.at(-1).payload, '__proto__', {
      value: { forged: true }, enumerable: true,
    });
    assert.match(JSON.stringify(prototypeTampered), /"__proto__"/);
    assert.throws(() => verifyExport(h.db, prototypeTampered), /hash does not verify/);
    const stateTampered = structuredClone(audit);
    stateTampered.rooms[0].finalState.auditTamper = true;
    assert.throws(() => verifyExport(h.db, stateTampered), /audit bundle was altered/);
    const prototypeStateTampered = JSON.parse(JSON.stringify(audit));
    Object.defineProperty(prototypeStateTampered.rooms[0].finalState, '__proto__', {
      value: { forged: true }, enumerable: true,
    });
    assert.throws(() => verifyExport(h.db, prototypeStateTampered), /audit bundle was altered/);
    const resultTampered = structuredClone(audit);
    resultTampered.resultProvenance[0].result.finalProjection.auditTamper = true;
    assert.throws(() => verifyExport(h.db, resultTampered), /audit bundle was altered/);
    const decisionTampered = structuredClone(audit);
    decisionTampered.rooms[0].decisions[0].action.choice = 'scissors';
    assert.throws(() => verifyExport(h.db, decisionTampered), /action event does not match decision|audit bundle was altered/);
    const rosterTampered = structuredClone(audit);
    rosterTampered.roster[0].name = 'Edited after export';
    assert.throws(() => verifyExport(h.db, rosterTampered), /does not match the seated student|Session audit material was altered/);
    const algorithmTampered = structuredClone(audit);
    algorithmTampered.eventChain.algorithm = 'none';
    assert.throws(() => verifyExport(h.db, algorithmTampered), /Unexpected event-chain algorithm/);
    const botTopologyTampered = structuredClone(audit);
    const serverSeat = botTopologyTampered.rooms[0].players.find((player) => player.accountKind === 'server');
    serverSeat.botKind = 'random';
    const creation = botTopologyTampered.events.find((event) => event.type === 'room_created');
    creation.payload.players.find((player) => player.id === serverSeat.id).botKind = 'random';
    rechainAuditEvents(botTopologyTampered);
    assert.throws(() => verifyExport(h.db, botTopologyTampered), /server-seat policy does not match/);
    const dispositionTampered = structuredClone(audit);
    dispositionTampered.events.find((event) => event.type === 'room_completed').type = 'room_voided';
    rechainAuditEvents(dispositionTampered);
    assert.throws(() => verifyExport(h.db, dispositionTampered), /exactly one room_completed disposition/);
    const eventAfterRoomSeal = structuredClone(audit);
    const roomSealIndex = eventAfterRoomSeal.events.findIndex((event) => event.type === 'room_audit_sealed');
    const roomSeal = eventAfterRoomSeal.events[roomSealIndex];
    eventAfterRoomSeal.events.splice(roomSealIndex + 1, 0, {
      ...structuredClone(roomSeal),
      type: 'room_error',
      payload: { message: 'forged post-seal event' },
      sequence: roomSeal.sequence + 1,
    });
    eventAfterRoomSeal.events.forEach((event, index) => { event.id = index + 1; });
    rechainAuditEvents(eventAfterRoomSeal);
    assert.throws(() => verifyExport(h.db, eventAfterRoomSeal), /disposition and audit seal must be its final two events/);
    const eventBetweenSessionDispositionAndSeal = structuredClone(audit);
    const sessionSealIndex = eventBetweenSessionDispositionAndSeal.events
      .findIndex((event) => event.type === 'session_audit_sealed');
    eventBetweenSessionDispositionAndSeal.events.splice(sessionSealIndex, 0, {
      ...structuredClone(eventBetweenSessionDispositionAndSeal.events[sessionSealIndex]),
      type: 'session_paused',
      payload: { pausedAt: 0 },
    });
    eventBetweenSessionDispositionAndSeal.events.forEach((event, index) => { event.id = index + 1; });
    rechainAuditEvents(eventBetweenSessionDispositionAndSeal);
    assert.throws(() => verifyExport(h.db, eventBetweenSessionDispositionAndSeal),
      /Session disposition must immediately precede/);
    for (const malformedRoomId of [null, '']) {
      const wrongScope = structuredClone(audit);
      const sessionDispositionIndex = wrongScope.events
        .findIndex((event) => ['session_completed', 'session_voided'].includes(event.type));
      const roomAction = structuredClone(wrongScope.events.find((event) => event.type === 'student_action'));
      roomAction.roomId = malformedRoomId;
      roomAction.sequence = null;
      wrongScope.events.splice(sessionDispositionIndex, 0, roomAction);
      wrongScope.events.forEach((event, index) => { event.id = index + 1; });
      rechainAuditEvents(wrongScope);
      assert.throws(() => verifyExport(h.db, wrongScope), /Room event .* has an invalid room id/);
    }
    const unknownEventType = structuredClone(audit);
    const unknownTypeEvent = unknownEventType.events.find((event) => event.type === 'student_action');
    unknownTypeEvent.type = 'unversioned_event';
    rechainAuditEvents(unknownEventType);
    assert.throws(() => verifyExport(h.db, unknownEventType), /unsupported event type/);
    const forgedTransition = structuredClone(audit);
    forgedTransition.controllerTransitions.push({ roomId: null, playerId: participant.id, controller: 'bot' });
    assert.throws(() => verifyExport(h.db, forgedTransition), /transition count does not match|unknown room/);
    const signatureTampered = structuredClone(audit);
    signatureTampered.authenticity.signature =
      `${signatureTampered.authenticity.signature[0] === 'A' ? 'B' : 'A'}${signatureTampered.authenticity.signature.slice(1)}`;
    assert.throws(() => verifyExport(h.db, signatureTampered), /signature does not verify/);
    const wrongKeyDb = new Database(':memory:', { encryptionKey: crypto.randomBytes(32) });
    try {
      assert.throws(() => verifyExport(wrongKeyDb, audit), /different public key/);
    } finally { wrongKeyDb.close(); }
  } finally { h.close(); }
});

for (const { label, version, terminal } of [
  { label: 'missing topology version', version: undefined, terminal: false },
  { label: 'different topology version', version: 'seating-v2', terminal: false },
  { label: 'different topology version in a terminal record', version: 'seating-v2', terminal: true },
]) {
  test(`platform restore fails without writes for ${label}`, async () => {
    const h = harness();
    let originalOpen = true;
    let reopenedDb;
    try {
      h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
      if (terminal) {
        h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Version boundary' });
        await h.platform.startSession();
        await h.platform.endSession();
      }
      const changedConfig = { ...h.platform.session.config };
      if (version === undefined) delete changedConfig.auditTopologyVersion;
      else changedConfig.auditTopologyVersion = version;
      h.platform.session.config = changedConfig;
      h.db.updateSession(h.platform.session);
      const sessionId = h.platform.session.id;
      h.platform.close();
      h.db.close();
      originalOpen = false;

      reopenedDb = new Database(h.filename);
      const beforeSession = reopenedDb.session(sessionId);
      const beforeEventCount = reopenedDb.events(sessionId).length;
      const beforeEventRoot = reopenedDb.eventRoot(sessionId);
      const beforeIntegrity = reopenedDb.verifyDatabaseIntegrity();
      assert.throws(() => new Platform(reopenedDb), /Unsupported audit topology version; expected seating-v3/);
      assert.deepEqual(reopenedDb.session(sessionId), beforeSession);
      assert.equal(reopenedDb.events(sessionId).length, beforeEventCount);
      assert.equal(reopenedDb.eventRoot(sessionId), beforeEventRoot);
      assert.deepEqual(reopenedDb.verifyDatabaseIntegrity(), beforeIntegrity);
    } finally {
      if (originalOpen) {
        h.platform.close();
        h.db.close();
      }
      reopenedDb?.close();
      fs.rmSync(h.directory, { recursive: true, force: true });
    }
  });
}

test('audit topology compatibility is checked before Platform performs any startup write', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-topology-gate-'));
  const filename = path.join(directory, 'test.sqlite');
  const db = new Database(filename);
  try {
    const createdAt = new Date().toISOString();
    db.insertSession({
      id: 'session_pre_topology',
      joinCode: '123456',
      state: 'lobby',
      game: 'rps',
      mode: 'strategy',
      config: { rulesVersion: 'v3', botVersion: 'v3', rounds: 10, turnSeconds: 30 },
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    });
    const sessionBefore = db.session('session_pre_topology');
    const eventRootBefore = db.eventRoot('session_pre_topology');
    const integrityBefore = db.verifyDatabaseIntegrity();
    const snapshotRows = () => db.db.prepare(
      "SELECT COUNT(*) AS count FROM app_settings WHERE key='snapshot_revision'",
    ).get().count;
    assert.equal(snapshotRows(), 0);
    assert.throws(() => new Platform(db), /Unsupported audit topology version; expected seating-v3/);
    assert.equal(snapshotRows(), 0);
    assert.deepEqual(db.session('session_pre_topology'), sessionBefore);
    assert.equal(db.eventRoot('session_pre_topology'), eventRootBefore);
    assert.deepEqual(db.verifyDatabaseIntegrity(), integrityBefore);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retention purge can remove the latest terminal activity once its cutoff has passed', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Expired activity' });
    const participant = h.platform.authenticate(joined.token);
    await h.platform.startSession();
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(participant, `expired-${round}`, { type: 'play', choice: 'rock' });
    }
    const sessionId = h.platform.session.id;
    h.platform.session.completedAt = '2020-01-01T00:00:00.000Z';
    h.platform.session.updatedAt = '2020-01-01T00:00:00.000Z';
    h.db.updateSession(h.platform.session);

    const purge = h.platform.purgeExpiredData();
    assert.equal(purge.sessions, 1);
    assert.equal(purge.purged[0].sessionId, sessionId);
    assert.equal(h.platform.session, null);
    assert.equal(h.platform.participants.size, 0);
    assert.equal(h.platform.rooms.size, 0);
    assert.equal(h.db.session(sessionId), undefined);
    assert.equal(h.db.participant(participant.id), undefined);
  } finally { h.close(); }
});

test('running room state and participant authentication survive a process-style restart', async () => {
  const h = harness();
  let token;
  let participantId;
  try {
    h.platform.createSession({ game: 'rps', mode: 'random', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Reconnect Student' });
    token = joined.token;
    participantId = joined.participant.id;
    await h.platform.startSession();
    await h.platform.applyAction(h.platform.authenticate(token), 'first', { type: 'play', choice: 'paper' });
    h.platform.close();
    h.db.close();

    const reopenedDb = new Database(h.filename);
    const restored = new Platform(reopenedDb);
    try {
    const participant = restored.authenticate(token);
    assert.equal(participant.id, participantId);
    assert.equal(restored.studentSnapshot(participant).room.state.history.length, 1);
    assert.equal(restored.studentSnapshot(participant).actionEpoch, 1);
    assert.equal(restored.session.state, 'paused');
    await restored.resumeSession();
    assert.equal(restored.session.state, 'running');
    await assert.rejects(() => restored.applyAction(participant, 'first', { type: 'play', choice: 'rock' }), /Duplicate/);
    await assert.rejects(() => restored.applyAction(participant, 'stale-after-restart', { type: 'play', choice: 'rock' }, 0), /Stale action/);
    } finally {
      restored.close();
      reopenedDb.close();
    }
  } finally {
    fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('room ordinals keep instructor table numbers stable across restart', async () => {
  const h = harness();
  let restored;
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (let index = 0; index < 10; index += 1) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Table order ${index}` });
    }
    await h.platform.startSession();
    const before = [...h.platform.rooms.keys()];
    const beforeTables = new Map([...h.platform.participants.values()].map((participant) => [
      participant.id,
      before.indexOf(participant.roomId) + 1,
    ]));
    assert.deepEqual(h.db.rooms(h.platform.session.id).map((room) => room.ordinal), [0, 1, 2, 3, 4]);

    h.platform.close();
    restored = new Platform(h.db);
    assert.deepEqual([...restored.rooms.keys()], before);
    for (const participant of restored.participants.values()) {
      assert.equal([...restored.rooms.keys()].indexOf(participant.roomId) + 1, beforeTables.get(participant.id));
    }
  } finally {
    restored?.close();
    h.close();
  }
});

test('normal startup rejects an offline room-schema downgrade', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-room-migration-'));
  const filename = path.join(directory, 'test.sqlite');
  let db = new Database(filename);
  let platform = withTestRoster(new Platform(db));
  try {
    platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (let index = 0; index < 8; index += 1) {
      platform.join({ joinCode: platform.session.joinCode, name: `Legacy table ${index}` });
    }
    await platform.startSession();
    platform.close();
    db.close();

    const legacy = new DatabaseSync(filename);
    for (const { name } of legacy.prepare(`SELECT name FROM sqlite_schema
      WHERE type='trigger' AND name LIKE 'agentic_integrity_rooms_%'`).all()) {
      legacy.exec(`DROP TRIGGER "${name}"`);
    }
    legacy.exec('DROP INDEX idx_rooms_session_ordinal; ALTER TABLE rooms DROP COLUMN ordinal;');
    legacy.close();

    assert.throws(() => new Database(filename), /schema manifest could not be authenticated/);
  } finally {
    platform?.close();
    try { db?.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('per-student action epochs reject duplicate-tab moves without blocking simultaneous opponents', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const firstJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'First tab' });
    const secondJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Opponent' });
    await h.platform.startSession();
    const first = h.platform.authenticate(firstJoin.token);
    const second = h.platform.authenticate(secondJoin.token);
    const firstEpoch = h.platform.studentSnapshot(first).actionEpoch;
    const secondEpoch = h.platform.studentSnapshot(second).actionEpoch;
    assert.equal(firstEpoch, 0);
    assert.equal(secondEpoch, 0);

    const firstResult = await h.platform.applyAction(first, 'first-rock', { type: 'play', choice: 'rock' }, firstEpoch);
    const secondResult = await h.platform.applyAction(second, 'second-paper', { type: 'play', choice: 'paper' }, secondEpoch);
    assert.equal(firstResult.actionEpoch, 1);
    assert.equal(secondResult.actionEpoch, 1);
    assert.ok(firstResult.actionResult);
    assert.ok(secondResult.actionResult);
    await assert.rejects(
      () => h.platform.applyAction(first, 'stale-second-click', { type: 'play', choice: 'scissors' }, firstEpoch),
      /Stale action/
    );
    assert.equal(h.db.decisions(h.platform.session.id, first.id).length, 1);

    await h.platform.applyAction(first, 'next-round-first', { type: 'play', choice: 'paper' }, 1);
    await h.platform.applyAction(second, 'next-round-second', { type: 'play', choice: 'rock' }, 1);
    assert.equal(h.platform.studentSnapshot(first).actionEpoch, 2);
    assert.equal(h.platform.studentSnapshot(second).actionEpoch, 2);
  } finally { h.close(); }
});

test('future action epochs cannot be prequeued before their decision exists', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Epoch prequeue' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const [current, future] = await Promise.allSettled([
      h.platform.applyAction(participant, 'epoch-current', { type: 'play', choice: 'rock' }, 0),
      h.platform.applyAction(participant, 'epoch-future', { type: 'play', choice: 'paper' }, 1),
    ]);
    assert.equal(current.status, 'fulfilled');
    assert.equal(future.status, 'rejected');
    assert.match(future.reason.message, /Stale action/);
    assert.equal(h.platform.rooms.get(participant.roomId).engine.state.history.length, 1);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 1);
    assert.equal(h.platform.studentSnapshot(participant).actionEpoch, 1);
  } finally { h.close(); }
});

test('live opponents cannot prequeue a move before it becomes actionable', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const firstJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'No prequeue A' });
    const secondJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'No prequeue B' });
    await h.platform.startSession();
    const first = h.platform.authenticate(firstJoin.token);
    const second = h.platform.authenticate(secondJoin.token);
    const room = h.platform.rooms.get(first.roomId);

    await h.platform.applyAction(first, 'live-a-round-1', { type: 'play', choice: 'rock' }, 0);
    const resolvingOpponent = h.platform.applyAction(second, 'live-b-round-1', { type: 'play', choice: 'scissors' }, 0);
    const prematureNextMove = h.platform.applyAction(first, 'live-a-round-2-too-early', { type: 'play', choice: 'paper' }, 1);

    await assert.rejects(prematureNextMove, /No decision was available/);
    await resolvingOpponent;
    assert.equal(room.engine.state.history.length, 1);
    assert.equal(h.db.actionExists(room.id, 'live-a-round-2-too-early'), false);
    assert.equal(h.db.decisions(h.platform.session.id, first.id).length, 1);
    assert.equal(h.platform.studentSnapshot(first).actionEpoch, 1);
    assert.equal(room.engine.legalActions(first.id).length > 0, true);
  } finally { h.close(); }
});

test('restart atomically drains a legacy pending bot turn exactly once', async () => {
  const h = harness();
  let token;
  let restored;
  let verified;
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Legacy recovery' });
    token = joined.token;
    await h.platform.startSession();
    const participant = h.platform.authenticate(token);
    const room = h.platform.rooms.get(participant.roomId);
    room.engine.act(participant.id, { type: 'play', choice: 'rock' });
    room.save();
    assert.equal(room.engine.state.history.length, 1);
    assert.equal(Object.keys(room.engine.state.submissions).length, 0);
    const botEventsBefore = h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'bot_action').length;
    h.platform.close();

    restored = new Platform(h.db);
    const restoredParticipant = restored.authenticate(token);
    const restoredRoom = restored.rooms.get(restoredParticipant.roomId);
    assert.equal(restoredRoom.engine.state.history.length, 1);
    assert.equal(restored.session.state, 'paused');
    assert.equal(Object.keys(restoredRoom.engine.state.submissions).length, 0);
    assert.equal(h.db.events(restored.session.id, restoredRoom.id).filter((event) => event.type === 'bot_action').length, botEventsBefore);
    await restored.resumeSession();
    assert.equal(Object.keys(restoredRoom.engine.state.submissions).length, 1);
    assert.equal(h.db.events(restored.session.id, restoredRoom.id).filter((event) => event.type === 'bot_action').length, botEventsBefore + 1);
    restored.close();

    verified = new Platform(h.db);
    const verifiedRoom = verified.rooms.get(verified.authenticate(token).roomId);
    assert.equal(verifiedRoom.engine.state.history.length, 1);
    assert.equal(Object.keys(verifiedRoom.engine.state.submissions).length, 1);
    assert.equal(h.db.events(verified.session.id, verifiedRoom.id).filter((event) => event.type === 'bot_action').length, botEventsBefore + 1);
  } finally {
    restored?.close();
    verified?.close();
    h.close();
  }
});

test('configuration is normalized before persistence and a faulty room can be voided without rewriting it', async () => {
  const h = harness();
  try {
    assert.throws(() => h.platform.createSession({ game: 'liars_dice', mode: 'live', rounds: 30 }), /3 to 20/);
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const first = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    await h.platform.voidRoom(room.id, 'Projector interruption');
    assert.equal(room.status, 'voided');
    assert.equal(h.platform.session.state, 'completed');
    assert.equal(h.platform.studentSnapshot(h.platform.authenticate(first.token)).room.status, 'voided');
    assert.ok(h.db.events(h.platform.session.id, room.id).some((event) => event.type === 'room_voided'));
  } finally { h.close(); }
});

test('student coaching exports remain unavailable during live play', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const first = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(first.token);
    assert.equal(h.platform.studentSnapshot(participant).exportAvailable, false);
    assert.throws(() => h.platform.exportMarkdown(participant.id), /after the entire activity is complete/);
  } finally { h.close(); }
});

test('a fast table cannot export strategy feedback while another table is still playing', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const fastJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Fast table' });
    const slowJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Slow table' });
    await h.platform.startSession();
    const fast = h.platform.authenticate(fastJoin.token);
    const slow = h.platform.authenticate(slowJoin.token);

    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(fast, `fast-${round}`, { type: 'play', choice: 'rock' });
    }
    assert.equal(h.platform.rooms.get(fast.roomId).engine.isComplete(), true);
    assert.equal(h.platform.session.state, 'running');
    assert.equal(h.platform.studentSnapshot(fast).exportAvailable, false);
    assert.throws(() => h.platform.studentExport(fastJoin.token), /entire activity is complete/);

    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(slow, `slow-${round}`, { type: 'play', choice: 'paper' });
    }
    assert.equal(h.platform.session.state, 'completed');
    assert.equal(h.platform.studentSnapshot(fast).exportAvailable, true);
    assert.match(h.platform.studentExport(fastJoin.token).markdown, /empiricalBestResponse/);
  } finally { h.close(); }
});

test("persisted decision contexts are immutable pre-action snapshots", async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'liars_dice', mode: 'live', rounds: 3 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'First student' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Second student' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    const bidder = h.platform.participants.get(room.players[room.engine.state.currentIndex].id);
    const challenger = [...h.platform.participants.values()].find((participant) => participant.id !== bidder.id);
    await h.platform.applyAction(bidder, 'opening-bid', { type: 'bid', quantity: 1, face: 2 });
    const before = structuredClone(room.engine.decisionContext(challenger.id));
    await h.platform.applyAction(challenger, 'challenge', { type: 'challenge' });
    const [row] = h.db.decisions(h.platform.session.id, challenger.id);
    assert.deepEqual(JSON.parse(row.context_json), before);
    assert.notDeepEqual(room.engine.state.scores, before.scores);
  } finally { h.close(); }
});

test('rejected choices are auditable, idempotent, and cannot partially mutate a room', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Rejected trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    await h.platform.applyAction(participant, 'reserve-one', { type: 'limit', side: 'buy', price: 1, quantity: 5 });
    await h.platform.applyAction(participant, 'reserve-two', { type: 'limit', side: 'buy', price: 1, quantity: 5 });
    const room = h.platform.rooms.get(participant.roomId);
    const before = structuredClone(room.engine.serialize());
    const context = structuredClone(room.engine.decisionContext(participant.id));
    await assert.rejects(() => h.platform.applyAction(participant, 'overcommitted',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /inventory capacity/);
    const after = structuredClone(room.engine.serialize());
    assert.deepEqual(withoutTradingClock(after), withoutTradingClock(before));
    assert.ok(after.remainingMs <= before.remainingMs && before.remainingMs - after.remainingMs < 1_000);
    const rows = h.db.decisions(h.platform.session.id, participant.id);
    const rejected = rows.at(-1);
    assert.deepEqual(JSON.parse(rejected.context_json), context);
    assert.deepEqual(JSON.parse(rejected.outcome_json), {
      type: 'rejected_action', actionId: 'overcommitted', code: 'INVALID_GAME_ACTION'
    });
    await assert.rejects(() => h.platform.applyAction(participant, 'overcommitted',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /Duplicate/);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 3);
    await h.platform.endSession();
    const packet = h.platform.exportMarkdown(participant.id);
    assert.match(packet, /"rejectedDecisions": 1/);
    assert.match(packet, /INVALID_GAME_ACTION/);
  } finally { h.close(); }
});

test('durable persisted-action budgets bound accepted and rejected trading spam', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Bounded trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    h.db.transaction(() => {
      for (let index = 0; index < 299; index += 1) {
        h.db.recordAction(room.id, `prior-${index}`, participant.id);
      }
    });

    const accepted = await h.platform.applyAction(participant, 'no-fill-300',
      { type: 'market', side: 'buy', quantity: 1 }, 0);
    assert.equal(accepted.actionResult.filledQuantity, 0);
    assert.equal(accepted.actionResult.cancelledQuantity, 1);
    assert.equal(h.db.persistedActionCounts(h.platform.session.id, room.id, participant.id).player, 300);
    await assert.rejects(
      () => h.platform.applyAction(participant, 'over-budget', { type: 'market', side: 'buy', quantity: 1 }, 1),
      /persisted-action limit/,
    );
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 1);
    assert.equal(room.engine.state.trades.length, 0);
  } finally { h.close(); }
});

test('unexpected engine exceptions roll back gameplay and durably quarantine the room', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Rollback trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    const before = structuredClone(room.engine.serialize());
    const counter = room.rng.counter;
    room.engine.act = () => {
      room.engine.state.cash[participant.id] = -999;
      room.rng.counter += 7;
      throw new Error('Injected engine invariant failure');
    };
    await assert.rejects(() => h.platform.applyAction(participant, 'rollback', { type: 'limit', side: 'buy', price: 1, quantity: 1 }),
      /Injected engine invariant failure/);
    const after = structuredClone(room.engine.serialize());
    assert.deepEqual(withoutTradingClock(after), withoutTradingClock(before));
    assert.ok(after.remainingMs <= before.remainingMs && before.remainingMs - after.remainingMs < 1_000);
    assert.equal(room.rng.counter, counter);
    assert.equal(room.unhealthy, 'Injected engine invariant failure');
    assert.equal(room.status, 'unhealthy');
    const quarantinedSnapshot = h.platform.studentSnapshot(participant);
    assert.equal(quarantinedSnapshot.room.status, 'unhealthy');
    assert.equal(quarantinedSnapshot.room.state.legalActions.length, 0);
    assert.equal(h.db.actionExists(room.id, 'rollback'), false);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 0);
    assert.equal(h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'room_error').length, 1);
  } finally { h.close(); }
});

test('an expired trading action persists only the deadline closure and remains retryable after storage failure', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Deadline trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    let clock = 0;
    room.engine.monotonicNow = () => clock;
    room.engine.clockAnchor = 0;
    room.engine.state.remainingMs = 1;
    room.engine.state.endsAt = Date.now() + 1;
    clock = 2;

    const originalSave = h.db.saveRoom.bind(h.db);
    let tripped = false;
    h.db.saveRoom = (...args) => {
      if (!tripped) {
        tripped = true;
        throw new Error('Injected deadline persistence failure');
      }
      return originalSave(...args);
    };
    const action = { type: 'limit', side: 'buy', price: 100, quantity: 1 };
    await assert.rejects(() => h.platform.applyAction(participant, 'deadline-race', action), /Injected deadline persistence failure/);
    assert.equal(room.engine.state.status, 'running');
    assert.equal(room.engine.state.remainingMs, 0);
    assert.equal(h.db.actionExists(room.id, 'deadline-race'), false);

    await assert.rejects(() => h.platform.applyAction(participant, 'deadline-race', action), /market deadline expired/i);
    assert.equal(room.engine.isComplete(), true);
    assert.equal(room.status, 'completed');
    assert.equal(h.db.actionExists(room.id, 'deadline-race'), false);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 0);
    assert.equal(h.db.resultProvenance(h.platform.session.id, room.id).length, room.players.length);
  } finally { h.close(); }
});

test('a connected staller is timed out, made permanently ineligible, and excluded from outcome analytics', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10, turnSeconds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Connected staller' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    h.platform.setConnected(participant.id, true);
    const room = h.platform.rooms.get(participant.roomId);
    room.engine.state._humanDeadlines[participant.id] = 0;

    await h.platform.tick();
    assert.equal(participant.competitiveEligible, false);
    assert.equal(room.participantPlayer(participant.id).competitiveEligible, false);
    assert.equal(h.db.participant(participant.id).competitive_eligible, 0);
    assert.equal(h.db.controllerTransitions(h.platform.session.id, participant.id).at(-1).controller, 'system');
    const [timeout] = h.db.decisions(h.platform.session.id, participant.id)
      .filter((row) => JSON.parse(row.outcome_json).type === 'timeout_action');
    assert.ok(timeout);

    await h.platform.endSession();
    const packet = h.platform.exportMarkdown(participant.id);
    assert.match(packet, /Authenticated-submission result eligible under game controls: no/);
    assert.match(packet, /"automatedDecisions": 1/);
    assert.match(packet, /"outcomeMetricsAuthoritative": false/);
    assert.match(packet, /"outcomes": null/);
    const result = h.db.resultProvenance(h.platform.session.id, room.id)
      .find((entry) => entry.player_id === participant.id);
    assert.equal(result.competitive_eligible, 0);
    assert.equal(result.controller_summary, 'mixed');
    assert.doesNotThrow(() => verifyExport(h.db, h.platform.classAudit()));
  } finally { h.close(); }
});

test('live peer outcomes are diagnostic only even when every action is authenticated', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const firstJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Peer A' });
    const secondJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Peer B' });
    await h.platform.startSession();
    const first = h.platform.authenticate(firstJoin.token);
    const second = h.platform.authenticate(secondJoin.token);
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(first, `peer-a-${round}`, { type: 'play', choice: 'rock' });
      await h.platform.applyAction(second, `peer-b-${round}`, { type: 'play', choice: 'paper' });
    }
    assert.equal(h.platform.session.state, 'completed');
    const room = h.platform.rooms.get(first.roomId);
    assert.equal(h.db.resultProvenance(h.platform.session.id, room.id)
      .filter((entry) => [first.id, second.id].includes(entry.player_id))
      .every((entry) => entry.competitive_eligible === 0), true);
    const packet = h.platform.exportMarkdown(first.id);
    assert.match(packet, /Authenticated-submission result eligible under game controls: no/);
    assert.match(packet, /"outcomeMetricsAuthoritative": false/);
    assert.match(packet, /"outcomes": null/);
    assert.match(packet, /"recordedDecisions": 10/);
    const forgedSeating = structuredClone(h.platform.classAudit());
    const reveal = forgedSeating.events.find((event) => event.type === 'seating_draw_revealed');
    reveal.payload.order.reverse();
    rechainAuditEvents(forgedSeating);
    assert.throws(() => verifyExport(h.db, forgedSeating), /order does not match the committed shuffle/);
  } finally { h.close(); }
});

test('audit verification rejects internally consistent collusive regrouping', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (const name of ['Group A', 'Group B', 'Group C', 'Group D']) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name });
    }
    await h.platform.startSession();
    await h.platform.endSession();
    const audit = h.platform.classAudit();
    assert.doesNotThrow(() => verifyExport(h.db, audit));

    const regrouped = structuredClone(audit);
    const [firstRoom, secondRoom] = regrouped.rooms;
    [firstRoom.players[0], secondRoom.players[0]] = [secondRoom.players[0], firstRoom.players[0]];
    const reveal = regrouped.events.find((event) => event.type === 'seating_draw_revealed');
    for (const room of [firstRoom, secondRoom]) {
      reveal.payload.rooms.find((entry) => entry.id === room.id).players = room.players.map((player) => player.id);
      const created = regrouped.events.find((event) => event.type === 'room_created' && event.roomId === room.id);
      created.payload.players = room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isBot: player.accountKind === 'server',
        botKind: player.accountKind === 'server' ? player.botKind : null,
      }));
    }
    rechainAuditEvents(regrouped);
    assert.throws(() => verifyExport(h.db, regrouped), /student grouping does not match the shuffled order/);
  } finally { h.close(); }
});

test('whole-session void preserves an already sealed room and invalidates its effective result', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'random', rounds: 10 });
    const finishedJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Finished room' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Still playing' });
    await h.platform.startSession();
    const finished = h.platform.authenticate(finishedJoin.token);
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(finished, `finish-${round}`, { type: 'play', choice: 'rock' });
    }
    const finishedRoom = h.platform.rooms.get(finished.roomId);
    assert.equal(finishedRoom.status, 'completed');
    const sealed = h.db.resultProvenance(h.platform.session.id, finishedRoom.id)
      .find((entry) => entry.player_id === finished.id);
    assert.equal(sealed.competitive_eligible, 1);

    await h.platform.voidSession('Whole-class cancellation');
    assert.equal(h.platform.session.state, 'voided');
    assert.equal(finishedRoom.status, 'completed');
    assert.equal(h.db.resultProvenance(h.platform.session.id, finishedRoom.id)
      .find((entry) => entry.player_id === finished.id).id, sealed.id);
    const packet = h.platform.exportMarkdown(finished.id);
    assert.match(packet, /Game Decision Record — Cancelled Activity/);
    assert.match(packet, /Authenticated-submission result eligible under game controls: no/);
    assert.match(packet, /"outcomes": null/);
    const audit = h.platform.classAudit();
    assert.equal(audit.resultProvenance.find((entry) => entry.playerId === finished.id).effectiveCompetitiveEligible, false);
    assert.doesNotThrow(() => verifyExport(h.db, audit));
  } finally { h.close(); }
});

test('a removed roster identity can atomically receive one replacement invitation', () => {
  const h = harness();
  try {
    const created = h.platform.createSession({ game: 'rps', mode: 'random', rounds: 10,
      roster: [{ identity: 'student-recovery', name: 'Recovery Student' }] });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, inviteCode: created.invitations[0].inviteCode });
    const oldParticipantId = joined.participant.id;
    h.platform.removeParticipant(oldParticipantId);
    const roster = h.platform.instructorState().roster[0];
    assert.equal(roster.reissuable, true);
    const replacement = h.platform.rotateRosterInvitation(roster.id);
    const rejoined = h.platform.join({ joinCode: h.platform.session.joinCode, inviteCode: replacement.inviteCode });
    assert.notEqual(rejoined.participant.id, oldParticipantId);
    assert.equal(rejoined.participant.name, 'Recovery Student');
    assert.equal(h.platform.authenticate(joined.token), null);
    assert.throws(() => h.platform.join({ joinCode: h.platform.session.joinCode, inviteCode: replacement.inviteCode }), /used invitation/);
  } finally { h.close(); }
});

test('rules upgrade quarantines only unfinished rooms and preserves sealed results', async () => {
  const h = harness();
  let reopenedDb;
  let restored;
  try {
    h.platform.createSession({ game: 'rps', mode: 'random', rounds: 10 });
    const finishedJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Upgrade finished' });
    const unfinishedJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Upgrade unfinished' });
    await h.platform.startSession();
    const finished = h.platform.authenticate(finishedJoin.token);
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(finished, `upgrade-finish-${round}`, { type: 'play', choice: 'rock' });
    }
    const finishedRoom = h.platform.rooms.get(finished.roomId);
    const unfinishedRoom = [...h.platform.rooms.values()].find((room) => room.id !== finishedRoom.id);
    const sealedId = h.db.resultProvenance(h.platform.session.id, finishedRoom.id)
      .find((entry) => entry.player_id === finished.id).id;
    h.platform.session.config = { ...h.platform.session.config, rulesVersion: 'v2', botVersion: 'v2' };
    h.db.updateSession(h.platform.session);
    h.db.saveRoom(unfinishedRoom, { futureSchemaVersion: 99, incompatiblePayload: ['kept opaque'] });
    h.platform.close();
    h.db.close();

    reopenedDb = new Database(h.filename);
    restored = new Platform(reopenedDb);
    await restored.startupRecovery;
    assert.equal(restored.session.state, 'paused');
    assert.equal(restored.rooms.get(finishedRoom.id).status, 'completed');
    assert.equal(restored.rooms.get(unfinishedRoom.id).status, 'unhealthy');
    assert.deepEqual(restored.rooms.get(unfinishedRoom.id).engine.serialize(),
      { futureSchemaVersion: 99, incompatiblePayload: ['kept opaque'] });
    assert.equal(reopenedDb.resultProvenance(restored.session.id, finishedRoom.id)
      .find((entry) => entry.player_id === finished.id).id, sealedId);
    assert.equal(reopenedDb.events(restored.session.id, finishedRoom.id)
      .some((event) => event.type === 'room_version_quarantined'), false);
    const quarantinedSequence = restored.rooms.get(unfinishedRoom.id).sequence;
    restored.close();
    reopenedDb.close();
    reopenedDb = new Database(h.filename);
    restored = new Platform(reopenedDb);
    await restored.startupRecovery;
    assert.equal(reopenedDb.events(restored.session.id)
      .filter((event) => event.type === 'session_version_quarantined').length, 1);
    assert.equal(reopenedDb.events(restored.session.id, unfinishedRoom.id)
      .filter((event) => event.type === 'room_version_quarantined').length, 1);
    assert.equal(restored.rooms.get(unfinishedRoom.id).sequence, quarantinedSequence);

    await restored.endSession();
    assert.equal(restored.session.state, 'completed');
    assert.equal(restored.rooms.get(finishedRoom.id).status, 'completed');
    assert.equal(restored.rooms.get(unfinishedRoom.id).status, 'voided');
    const cancelledExport = restored.studentExport(unfinishedJoin.token);
    assert.equal(cancelledExport.artifact, 'decision-record');
    assert.match(cancelledExport.markdown, /saved game version is incompatible/i);
    assert.match(cancelledExport.markdown, /Authenticated-submission result eligible under game controls: no/);
    assert.doesNotThrow(() => verifyExport(reopenedDb, restored.classAudit()));
  } finally {
    restored?.close();
    reopenedDb?.close();
    fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('rules upgrade preserves and completes an interrupted durable ending transition', async () => {
  const h = harness();
  let reopenedDb;
  let restored;
  try {
    h.platform.createSession({ game: 'rps', mode: 'random', rounds: 10 });
    const finishedJoin = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Ending finished' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Ending unfinished' });
    await h.platform.startSession();
    const finished = h.platform.authenticate(finishedJoin.token);
    for (let round = 0; round < 10; round += 1) {
      await h.platform.applyAction(finished, `ending-upgrade-${round}`, { type: 'play', choice: 'paper' });
    }
    const finishedRoom = h.platform.rooms.get(finished.roomId);
    const unfinishedRoom = [...h.platform.rooms.values()].find((room) => room.id !== finishedRoom.id);
    unfinishedRoom.queue = new Promise(() => {});
    const ending = h.platform.endSession();
    ending.catch(() => {});
    assert.equal(h.platform.session.state, 'ending');
    h.platform.session.config = { ...h.platform.session.config, rulesVersion: 'v2', botVersion: 'v2' };
    h.db.updateSession(h.platform.session);
    h.platform.close();
    h.db.close();

    reopenedDb = new Database(h.filename);
    restored = new Platform(reopenedDb);
    assert.equal(restored.session.state, 'ending');
    await restored.startupRecovery;
    assert.equal(restored.session.state, 'completed');
    assert.equal(restored.rooms.get(finishedRoom.id).status, 'completed');
    assert.equal(restored.rooms.get(unfinishedRoom.id).status, 'voided');
    assert.equal(reopenedDb.events(restored.session.id)
      .filter((event) => event.type === 'session_ending').length, 1);
    assert.equal(reopenedDb.events(restored.session.id)
      .filter((event) => event.type === 'session_completed').length, 1);
  } finally {
    restored?.close();
    reopenedDb?.close();
    fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a failed quarantine write still blocks play and is retried durably', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Quarantine retry' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    room.engine.act = () => { throw new Error('Injected persistent engine failure'); };
    const originalSave = h.db.saveRoom.bind(h.db);
    let tripped = false;
    h.db.saveRoom = (candidate, state) => {
      if (!tripped && candidate.id === room.id && candidate.status === 'unhealthy') {
        tripped = true;
        throw new Error('Injected quarantine persistence failure');
      }
      return originalSave(candidate, state);
    };
    await assert.rejects(() => h.platform.applyAction(participant, 'quarantine-retry',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /Injected persistent engine failure/);
    assert.equal(room.status, 'unhealthy');
    assert.equal(room.unhealthy, 'Injected persistent engine failure');
    assert.equal(h.platform.pendingQuarantines.get(room.id), 'Injected persistent engine failure');
    assert.equal(h.db.rooms(h.platform.session.id).find((row) => row.id === room.id).status, 'running');
    await assert.rejects(() => h.platform.applyAction(participant, 'blocked-while-pending',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /Room is unhealthy/);

    await h.platform.tick();
    assert.equal(h.platform.pendingQuarantines.has(room.id), false);
    assert.equal(h.db.rooms(h.platform.session.id).find((row) => row.id === room.id).status, 'unhealthy');
    assert.equal(h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'room_error').length, 1);
  } finally { h.close(); }
});

test('an instructor terminal resolution cancels a pending quarantine retry', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Resolved quarantine' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    room.engine.act = () => { throw new Error('Injected terminal quarantine'); };
    const originalSave = h.db.saveRoom.bind(h.db);
    let tripped = false;
    h.db.saveRoom = (candidate, state) => {
      if (!tripped && candidate.id === room.id && candidate.status === 'unhealthy') {
        tripped = true;
        throw new Error('Injected pending quarantine write');
      }
      return originalSave(candidate, state);
    };
    await assert.rejects(() => h.platform.applyAction(participant, 'terminal-quarantine',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /Injected terminal quarantine/);
    assert.equal(h.platform.pendingQuarantines.has(room.id), true);
    await h.platform.endSession();
    assert.equal(room.status, 'voided');
    assert.equal(room.unhealthy, 'Injected terminal quarantine');
    assert.equal(h.platform.pendingQuarantines.has(room.id), false);
    await h.platform.tick();
    assert.equal(room.status, 'voided');
    assert.equal(h.db.rooms(h.platform.session.id).find((row) => row.id === room.id).status, 'voided');
    assert.equal(h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'room_error').length, 0);
  } finally { h.close(); }
});

test('typed game-action errors are student rejections rather than room failures', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Domain rejection' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    room.engine.act = () => { throw new GameActionError('Injected invalid student order'); };
    await assert.rejects(() => h.platform.applyAction(participant, 'domain-error',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /Injected invalid student order/);
    assert.equal(room.unhealthy, null);
    assert.equal(h.db.actionExists(room.id, 'domain-error'), true);
    assert.equal(JSON.parse(h.db.decisions(h.platform.session.id, participant.id).at(-1).outcome_json).type, 'rejected_action');
  } finally { h.close(); }
});

test('accepted actions, immediate bot play, and persistence form one retryable transaction', async (t) => {
  const cases = [
    {
      name: 'bot event failure',
      expectBotReplay: true,
      install(h, room, botAttempts) {
        const original = h.db.event.bind(h.db);
        let tripped = false;
        h.db.event = (entry) => {
          if (entry.type === 'bot_action') {
            botAttempts.push(clone({ actorId: entry.actorId, payload: entry.payload }));
            if (!tripped) {
              tripped = true;
              throw new Error('Injected bot event failure');
            }
          }
          return original(entry);
        };
      }
    },
    {
      name: 'decision failure',
      expectBotReplay: false,
      install(h, room) {
        const original = h.db.decision.bind(h.db);
        let tripped = false;
        h.db.decision = (entry) => {
          if (!tripped && entry.roomId === room.id) {
            tripped = true;
            throw new Error('Injected decision failure');
          }
          return original(entry);
        };
      }
    },
    {
      name: 'room save failure after bot play',
      expectBotReplay: true,
      install(h, room, botAttempts) {
        const originalEvent = h.db.event.bind(h.db);
        const originalSave = h.db.saveRoom.bind(h.db);
        let botSeen = false;
        let tripped = false;
        h.db.event = (entry) => {
          if (entry.type === 'bot_action') {
            botSeen = true;
            botAttempts.push(clone({ actorId: entry.actorId, payload: entry.payload }));
          }
          return originalEvent(entry);
        };
        h.db.saveRoom = (candidate, state) => {
          if (!tripped && candidate.id === room.id && botSeen) {
            tripped = true;
            throw new Error('Injected room save failure');
          }
          return originalSave(candidate, state);
        };
      }
    }
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const h = harness();
    try {
      h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
      const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Atomic student' });
      await h.platform.startSession();
      const participant = h.platform.authenticate(joined.token);
      const room = h.platform.rooms.get(participant.roomId);
      const actionId = 'atomic-action';
      const action = { type: 'play', choice: 'rock' };
      const beforeMemory = roomMemory(room);
      const beforeRoom = clone(h.db.rooms(h.platform.session.id).find((row) => row.id === room.id));
      const beforeEvents = clone(h.db.events(h.platform.session.id, room.id));
      const beforeDecisions = clone(h.db.decisions(h.platform.session.id, participant.id));
      const botAttempts = [];
      scenario.install(h, room, botAttempts);

      await assert.rejects(() => h.platform.applyAction(participant, actionId, action), /Injected/);
      assert.deepEqual(roomMemory(room), beforeMemory);
      assert.deepEqual(clone(h.db.rooms(h.platform.session.id).find((row) => row.id === room.id)), beforeRoom);
      assert.deepEqual(clone(h.db.events(h.platform.session.id, room.id)), beforeEvents);
      assert.deepEqual(clone(h.db.decisions(h.platform.session.id, participant.id)), beforeDecisions);
      assert.equal(h.db.actionExists(room.id, actionId), false);

      await h.platform.applyAction(participant, actionId, action);
      assert.equal(h.db.actionExists(room.id, actionId), true);
      assert.equal(room.engine.state.history.length, 1);
      assert.equal(room.sequence, beforeMemory.sequence + 2);
      assert.ok(room.rng.counter > beforeMemory.rngCounter);
      const addedEvents = h.db.events(h.platform.session.id, room.id).slice(beforeEvents.length);
      assert.deepEqual(addedEvents.map((entry) => entry.type), ['student_action', 'bot_action']);
      assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, beforeDecisions.length + 1);
      const acceptedCount = h.db.db.prepare(`SELECT COUNT(*) AS count FROM accepted_actions
        WHERE room_id=? AND action_id=?`).get(room.id, actionId).count;
      assert.equal(acceptedCount, 1);
      const persisted = h.db.rooms(h.platform.session.id).find((row) => row.id === room.id);
      assert.deepEqual(JSON.parse(persisted.state_json), room.engine.serialize());
      assert.equal(persisted.rng_counter, room.rng.counter);
      assert.equal(persisted.sequence, room.sequence);
      assert.equal(persisted.status, room.status);
      if (scenario.expectBotReplay) {
        assert.equal(botAttempts.length, 2);
        assert.deepEqual(botAttempts[1], botAttempts[0]);
      }
    } finally { h.close(); }
  });
});

test('a failed rejected-action audit rolls back and leaves its action id reusable', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'liars_dice', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Rejected atomic student' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    const before = roomMemory(room);
    const original = h.db.decision.bind(h.db);
    let tripped = false;
    h.db.decision = (entry) => {
      if (!tripped && entry.outcome?.type === 'rejected_action') {
        tripped = true;
        throw new Error('Injected rejected audit failure');
      }
      return original(entry);
    };
    const invalid = { type: 'challenge' };
    await assert.rejects(() => h.platform.applyAction(participant, 'rejected-atomic', invalid), /Injected rejected audit failure/);
    assert.deepEqual(roomMemory(room), before);
    assert.equal(h.db.actionExists(room.id, 'rejected-atomic'), false);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 0);
    await assert.rejects(() => h.platform.applyAction(participant, 'rejected-atomic', invalid), /Nothing to challenge/);
    assert.equal(h.db.actionExists(room.id, 'rejected-atomic'), true);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 1);
    assert.equal(h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'student_action_rejected').length, 1);
    await assert.rejects(() => h.platform.applyAction(participant, 'rejected-atomic', invalid), /Duplicate action/);
  } finally { h.close(); }
});

test('database transactions reject async and nested work without poisoning later transactions', () => {
  const h = harness();
  try {
    assert.throws(() => h.db.transaction(async () => {}), /synchronous/);
    assert.throws(() => h.db.transaction(() => h.db.transaction(() => {})), /Nested/);
    assert.equal(h.db.transaction(() => 42), 42);
  } finally { h.close(); }
});

test('post-commit broadcast and session-reconciliation failures do not undo a student action', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'strategy', rounds: 10 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Post-commit student' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    for (let round = 0; round < 9; round += 1) {
      await h.platform.applyAction(participant, `pre-final-${round}`, { type: 'play', choice: 'paper' });
    }
    const originalUpdate = h.db.updateSession.bind(h.db);
    let tripped = false;
    h.db.updateSession = (session) => {
      if (!tripped && session.state === 'completed') {
        tripped = true;
        throw new Error('Injected completion persistence failure');
      }
      return originalUpdate(session);
    };
    h.platform.onBroadcast = () => { throw new Error('Injected broadcast failure'); };
    await h.platform.applyAction(participant, 'final-action', { type: 'play', choice: 'paper' });
    const room = h.platform.rooms.get(participant.roomId);
    assert.equal(room.engine.isComplete(), true);
    assert.equal(h.db.actionExists(room.id, 'final-action'), true);
    assert.equal(h.platform.session.state, 'running');
    assert.match(h.platform.lastPersistenceError.message, /Injected completion/);
    assert.match(h.platform.lastBroadcastError.message, /Injected broadcast/);
    await h.platform.tick();
    assert.equal(h.platform.session.state, 'completed');
    assert.equal(h.db.activeSession().state, 'completed');
  } finally { h.close(); }
});

test('a running session cannot be replaced without an explicit end or void', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const original = h.platform.session.id;
    assert.throws(() => h.platform.createSession({ game: 'blackjack', mode: 'strategy', rounds: 1 }), /Complete or void/);
    assert.equal(h.platform.session.id, original);
    assert.equal(h.platform.rooms.size, 1);
    assert.equal(h.platform.participants.size, 2);
  } finally { h.close(); }
});

test('ending state rejects actions in later rooms before room fan-out completes', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const joins = Array.from({ length: 4 }, (_, index) =>
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Cutoff ${index + 1}` }));
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    let release;
    rooms[0].queue = new Promise((resolve) => { release = resolve; });
    const ending = h.platform.endSession();
    assert.equal(h.platform.session.state, 'ending');
    const later = joins.map((join) => h.platform.authenticate(join.token))
      .find((participant) => participant.roomId === rooms[1].id);
    await assert.rejects(() => h.platform.applyAction(later, 'after-cutoff', { type: 'play', choice: 'rock' }), /not running/i);
    release();
    await ending;
    assert.equal(h.platform.session.state, 'completed');
  } finally { h.close(); }
});

test('voiding state rejects actions in later rooms before room fan-out completes', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const joins = Array.from({ length: 4 }, (_, index) =>
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Void cutoff ${index + 1}` }));
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    let release;
    rooms[0].queue = new Promise((resolve) => { release = resolve; });
    const voiding = h.platform.voidSession('Class interruption');
    assert.equal(h.platform.session.state, 'voiding');
    const later = joins.map((join) => h.platform.authenticate(join.token))
      .find((participant) => participant.roomId === rooms[1].id);
    await assert.rejects(() => h.platform.applyAction(later, 'after-void-cutoff', { type: 'play', choice: 'paper' }), /not running/i);
    release();
    await voiding;
    assert.equal(h.platform.session.state, 'voided');
  } finally { h.close(); }
});

test('a stale table cancellation cannot rewrite a completed or already-voided table', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (const name of ['A', 'B', 'C', 'D']) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name });
    }
    await h.platform.startSession();
    const [completedRoom, voidedRoom] = [...h.platform.rooms.values()];
    h.platform.mutateRoom(completedRoom, () => {
      completedRoom.engine.forceComplete();
      completedRoom.status = 'completed';
      completedRoom.event('room_completed', 'system', { reason: 'game_complete', seed: completedRoom.rng.seedHex });
    });
    const completedEvents = h.db.events(h.platform.session.id, completedRoom.id).length;
    await assert.rejects(
      () => h.platform.voidRoom(completedRoom.id, 'Stale completed-table dialog'),
      (error) => error.status === 409 && /active table/i.test(error.message),
    );
    assert.equal(completedRoom.status, 'completed');
    assert.equal(h.db.events(h.platform.session.id, completedRoom.id).length, completedEvents);
    assert.equal(h.db.events(h.platform.session.id, completedRoom.id)
      .filter((event) => event.type === 'room_voided').length, 0);

    let release;
    voidedRoom.queue = new Promise((resolve) => { release = resolve; });
    const firstVoid = h.platform.voidRoom(voidedRoom.id, 'First table cancellation');
    const duplicateVoid = h.platform.voidRoom(voidedRoom.id, 'Duplicate stale cancellation');
    release();
    await Promise.all([firstVoid, duplicateVoid]);
    assert.equal(voidedRoom.status, 'voided');
    assert.equal(h.db.events(h.platform.session.id, voidedRoom.id)
      .filter((event) => event.type === 'room_voided').length, 1);
    const annotations = h.db.annotations(h.platform.session.id, voidedRoom.id)
      .filter((annotation) => annotation.kind === 'room_void');
    assert.deepEqual(annotations.map((annotation) => annotation.note), ['First table cancellation']);
  } finally { h.close(); }
});

test('an unhealthy table remains cancellable as the instructor recovery path', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    h.platform.mutateRoom(room, () => {
      room.status = 'unhealthy';
      room.unhealthy = 'Injected table failure';
      room.event('room_error', 'system', { message: room.unhealthy });
    });

    await h.platform.voidRoom(room.id, 'Instructor recovery cancellation');
    assert.equal(room.status, 'voided');
    assert.equal(room.unhealthy, 'Injected table failure');
    assert.equal(h.db.events(h.platform.session.id, room.id)
      .filter((event) => event.type === 'room_voided').length, 1);
  } finally { h.close(); }
});

test('an action queued behind table cancellation is rejected without an audit write', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const joins = ['A', 'B', 'C', 'D'].map((name) =>
      h.platform.join({ joinCode: h.platform.session.joinCode, name }));
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    const participant = joins.map((join) => h.platform.authenticate(join.token))
      .find((candidate) => candidate.roomId === room.id);
    let release;
    room.queue = new Promise((resolve) => { release = resolve; });
    const cancellation = h.platform.voidRoom(room.id, 'Cancel before queued action');
    const queuedAction = h.platform.applyAction(
      participant,
      'queued-after-cancel',
      { type: 'play', choice: 'rock' },
      0,
    );
    release();
    await cancellation;
    await assert.rejects(
      () => queuedAction,
      (error) => error.status === 409 && /active table/i.test(error.message),
    );
    assert.equal(h.platform.session.state, 'running');
    assert.equal(room.status, 'voided');
    assert.equal(h.db.actionExists(room.id, 'queued-after-cancel'), false);
    assert.equal(h.db.decisions(h.platform.session.id, participant.id).length, 0);
    const events = h.db.events(h.platform.session.id, room.id);
    const voidIndex = events.findIndex((event) => event.type === 'room_voided');
    assert.notEqual(voidIndex, -1);
    assert.equal(events.slice(voidIndex + 1).some((event) =>
      ['student_action', 'student_action_rejected'].includes(event.type)), false);
  } finally { h.close(); }
});

test('session cancellation rejects completed, archived, and ending sessions without rewriting them', async (t) => {
  for (const state of ['completed', 'archived', 'ending']) {
    await t.test(state, async () => {
      const h = harness();
      try {
        h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
        h.platform.session.state = state;
        h.platform.session.updatedAt = new Date().toISOString();
        if (state === 'completed') h.platform.session.completedAt = h.platform.session.updatedAt;
        h.db.updateSession(h.platform.session);
        const eventsBefore = h.db.events(h.platform.session.id).length;
        await assert.rejects(
          () => h.platform.voidSession('Stale activity dialog'),
          (error) => error.status === 409 && /cannot be voided/i.test(error.message),
        );
        assert.equal(h.platform.session.state, state);
        assert.equal(h.db.activeSession()?.state, state === 'archived' ? undefined : state);
        assert.equal(h.db.events(h.platform.session.id).length, eventsBefore);
        assert.equal(h.db.db.prepare(
          `SELECT COUNT(*) AS count FROM annotations WHERE session_id=? AND kind='void'`
        ).get(h.platform.session.id).count, 0);
      } finally { h.close(); }
    });
  }
});

test('concurrent activity cancellations coalesce and preserve the first terminal record', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    let release;
    room.queue = new Promise((resolve) => { release = resolve; });
    const first = h.platform.voidSession('First activity cancellation');
    const concurrent = h.platform.voidSession('Concurrent replacement note');
    assert.equal(h.platform.session.state, 'voiding');
    release();
    await Promise.all([first, concurrent]);

    assert.equal(h.platform.session.state, 'voided');
    const events = h.db.events(h.platform.session.id);
    assert.equal(events.filter((event) => event.type === 'session_voiding').length, 1);
    const terminalEvents = events.filter((event) => event.type === 'session_voided');
    assert.equal(terminalEvents.length, 1);
    assert.equal(JSON.parse(terminalEvents[0].payload_json).note, 'First activity cancellation');
    assert.equal(h.db.events(h.platform.session.id, room.id)
      .filter((event) => event.type === 'room_voided').length, 1);
    const annotations = h.db.annotations(h.platform.session.id, null)
      .filter((annotation) => annotation.kind === 'void');
    assert.deepEqual(annotations.map((annotation) => annotation.note), ['First activity cancellation']);

    await h.platform.voidSession('Later idempotent retry');
    assert.equal(h.db.events(h.platform.session.id)
      .filter((event) => event.type === 'session_voided').length, 1);
    assert.equal(h.db.db.prepare(
      `SELECT COUNT(*) AS count FROM annotations WHERE session_id=? AND room_id IS NULL AND kind='void'`
    ).get(h.platform.session.id).count, 1);
  } finally { h.close(); }
});

test('ending and cancelling are mutually exclusive while room queues drain', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    let release;
    room.queue = new Promise((resolve) => { release = resolve; });
    const ending = h.platform.endSession();
    assert.equal(h.platform.session.state, 'ending');
    await assert.rejects(
      () => h.platform.voidSession('Late cancellation'),
      (error) => error.status === 409 && /cannot be voided/i.test(error.message),
    );
    release();
    await ending;
    assert.equal(h.platform.session.state, 'completed');
    const eventTypes = h.db.events(h.platform.session.id).map((event) => event.type);
    assert.equal(eventTypes.filter((type) => type === 'session_ending').length, 1);
    assert.equal(eventTypes.filter((type) => type === 'session_completed').length, 1);
    assert.equal(eventTypes.some((type) => type === 'session_voiding' || type === 'session_voided'), false);
  } finally { h.close(); }
});

test('activity cancellation remains available from the lobby and while paused', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Joined before lobby cancellation' });
    await h.platform.voidSession('Lobby cancellation');
    assert.equal(h.platform.session.state, 'voided');
    assert.doesNotThrow(() => verifyExport(h.db, h.platform.classAudit()));

    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'B' });
    await h.platform.startSession();
    await h.platform.pauseSession();
    assert.equal(h.platform.session.state, 'paused');
    await h.platform.voidSession('Paused cancellation');
    assert.equal(h.platform.session.state, 'voided');
  } finally { h.close(); }
});

test('ending early preserves a table that was already voided', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const joins = Array.from({ length: 4 }, (_, index) =>
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Mixed result ${index + 1}` }));
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    assert.equal(rooms.length, 2);
    const voidedRoom = rooms[0];
    const completedRoom = rooms[1];
    const voidedParticipant = joins.map((join) => h.platform.authenticate(join.token))
      .find((participant) => participant.roomId === voidedRoom.id);

    await h.platform.voidRoom(voidedRoom.id, 'Table-specific interruption');
    const eventsBeforeEnd = h.db.events(h.platform.session.id, voidedRoom.id);
    const voidEvent = eventsBeforeEnd.find((event) => event.type === 'room_voided');
    assert.ok(voidEvent);
    assert.equal(JSON.parse(voidEvent.payload_json).note, 'Table-specific interruption');

    await h.platform.endSession();
    assert.equal(h.platform.session.state, 'completed');
    assert.equal(voidedRoom.status, 'voided');
    assert.equal(completedRoom.status, 'completed');
    assert.equal(h.platform.studentSnapshot(voidedParticipant).room.status, 'voided');
    const persisted = new Map(h.db.rooms(h.platform.session.id).map((room) => [room.id, room.status]));
    assert.equal(persisted.get(voidedRoom.id), 'voided');
    assert.equal(persisted.get(completedRoom.id), 'completed');
    const finalVoidRoomEvents = h.db.events(h.platform.session.id, voidedRoom.id);
    assert.equal(finalVoidRoomEvents.filter((event) => event.type === 'room_voided').length, 1);
    assert.equal(finalVoidRoomEvents.some((event) => event.type === 'room_completed'), false,
      'ending the session must not rewrite a previously voided table as completed');
  } finally { h.close(); }
});

test('restart automatically completes a durable ending transition', async () => {
  const h = harness();
  let reopenedDb;
  let restored;
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (let index = 1; index <= 4; index += 1) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Ending restart ${index}` });
    }
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    rooms[0].queue = new Promise(() => {});
    const interruptedEnding = h.platform.endSession();
    interruptedEnding.catch(() => {});
    assert.equal(h.platform.session.state, 'ending');
    assert.equal(h.db.activeSession().state, 'ending');
    assert.equal(h.db.events(h.platform.session.id).filter((event) => event.type === 'session_ending').length, 1);

    h.platform.close();
    h.db.close();
    reopenedDb = new Database(h.filename);
    restored = new Platform(reopenedDb);
    await restored.startupRecovery;

    assert.equal(restored.session.state, 'completed');
    assert.ok([...restored.rooms.values()].every((room) => room.status === 'completed'));
    assert.ok(reopenedDb.rooms(restored.session.id).every((room) => room.status === 'completed'));
    assert.equal(reopenedDb.events(restored.session.id).filter((event) => event.type === 'session_ending').length, 1);
    const completed = reopenedDb.events(restored.session.id).filter((event) => event.type === 'session_completed');
    assert.equal(completed.length, 1);
    assert.equal(JSON.parse(completed[0].payload_json).reason, 'instructor_end');
  } finally {
    restored?.close();
    reopenedDb?.close();
    fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('restart resumes a durable void with its original note across remaining records', async () => {
  const h = harness();
  let reopenedDb;
  let restored;
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    for (let index = 1; index <= 4; index += 1) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Void restart ${index}` });
    }
    await h.platform.startSession();
    const sessionId = h.platform.session.id;
    const rooms = [...h.platform.rooms.values()];
    const originalNote = 'Original evacuation note';
    rooms[1].queue = new Promise(() => {});
    const interruptedVoid = h.platform.voidSession(originalNote);
    interruptedVoid.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.platform.session.state, 'voiding');
    assert.equal(h.db.activeSession().state, 'voiding');
    assert.equal(rooms[0].status, 'voided');
    assert.equal(rooms[1].status, 'running');
    const transitionEvents = h.db.events(sessionId).filter((event) => event.type === 'session_voiding');
    assert.equal(transitionEvents.length, 1);
    assert.equal(JSON.parse(transitionEvents[0].payload_json).note, originalNote);
    assert.equal(JSON.parse(h.db.events(sessionId, rooms[0].id)
      .find((event) => event.type === 'room_voided').payload_json).note, originalNote);

    h.platform.close();
    h.db.close();
    reopenedDb = new Database(h.filename);
    restored = new Platform(reopenedDb);
    await restored.startupRecovery;

    assert.equal(restored.session.state, 'voided');
    assert.ok([...restored.rooms.values()].every((room) => room.status === 'voided'));
    assert.ok(reopenedDb.rooms(sessionId).every((room) => room.status === 'voided'));
    const events = reopenedDb.events(sessionId);
    assert.equal(events.filter((event) => event.type === 'session_voiding').length, 1);
    for (const room of restored.rooms.values()) {
      const roomVoids = reopenedDb.events(sessionId, room.id).filter((event) => event.type === 'room_voided');
      assert.equal(roomVoids.length, 1);
      assert.equal(JSON.parse(roomVoids[0].payload_json).note, originalNote);
    }
    const finalEvent = events.find((event) => event.type === 'session_voided');
    assert.ok(finalEvent);
    assert.equal(JSON.parse(finalEvent.payload_json).note, originalNote);
    const annotations = reopenedDb.annotations(sessionId);
    const finalAnnotation = annotations.find((annotation) => annotation.room_id == null && annotation.kind === 'void');
    assert.ok(finalAnnotation);
    assert.equal(finalAnnotation.note, originalNote);
  } finally {
    restored?.close();
    reopenedDb?.close();
    fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('bot substitution rejects completed, voided, and unhealthy tables', async (t) => {
  for (const terminalStatus of ['completed', 'voided', 'unhealthy']) {
    await t.test(terminalStatus, async () => {
      const h = harness();
      try {
        h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
        const joins = Array.from({ length: 4 }, (_, index) =>
          h.platform.join({ joinCode: h.platform.session.joinCode, name: `${terminalStatus} seat ${index + 1}` }));
        await h.platform.startSession();
        const room = [...h.platform.rooms.values()][0];
        const participant = joins.map((join) => h.platform.authenticate(join.token))
          .find((candidate) => candidate.roomId === room.id);

        if (terminalStatus === 'voided') {
          await h.platform.voidRoom(room.id, 'Table closed');
        } else if (terminalStatus === 'completed') {
          room.engine.forceComplete();
          room.status = 'completed';
          room.save();
        } else {
          room.status = 'unhealthy';
          room.unhealthy = 'Injected table failure';
          room.save();
        }

        await assert.rejects(
          () => h.platform.replaceWithBot(participant.id, true),
          /active, healthy table/,
        );
        assert.equal(room.participantPlayer(participant.id).isBot, false);
        assert.equal(h.db.events(h.platform.session.id, room.id)
          .some((event) => event.type === 'participant_replaced_by_bot'), false);
      } finally { h.close(); }
    });
  }
});

test('restart resets connectivity and preserves unhealthy room quarantine', async () => {
  const h = harness();
  let token;
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const first = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Restart A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Restart B' });
    token = first.token;
    await h.platform.startSession();
    const participant = h.platform.authenticate(token);
    h.platform.setConnected(participant.id, true);
    const room = h.platform.rooms.get(participant.roomId);
    room.status = 'unhealthy';
    room.unhealthy = 'Injected engine failure';
    room.save();
    h.platform.close();
    h.db.close();

    const reopenedDb = new Database(h.filename);
    const restored = new Platform(reopenedDb);
    try {
      const restoredParticipant = restored.authenticate(token);
      const restoredRoom = restored.rooms.get(restoredParticipant.roomId);
      assert.equal(restoredParticipant.connected, false);
      assert.match(restoredRoom.unhealthy, /review after server restart/);
      assert.equal(restored.instructorState().health.unhealthyRooms, 1);
      assert.equal(restored.session.state, 'paused');
      await restored.resumeSession();
      await assert.rejects(() => restored.applyAction(restoredParticipant, 'quarantined', { type: 'play', choice: 'rock' }), /review after server restart/);
    } finally {
      restored.close();
      reopenedDb.close();
    }
  } finally {
    fs.rmSync(h.directory, { recursive: true, force: true });
  }
});

test('the admission path has tested headroom for 150 participants', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 30 });
    for (let index = 1; index <= 150; index += 1) h.platform.join({ joinCode: h.platform.session.joinCode, name: `Load ${index}` });
    assert.throws(() => h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Over capacity' }), /capacity/);
    await h.platform.startSession();
    assert.equal(h.platform.rooms.size, 11);
    assert.equal(h.platform.instructorState().health.unhealthyRooms, 0);
  } finally { h.close(); }
});

test('75 students can submit concurrent collateralized trading actions', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joins = Array.from({ length: 75 }, (_, index) =>
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Concurrent trader ${index + 1}` }));
    await h.platform.startSession();
    const participants = joins.map((join) => h.platform.authenticate(join.token));
    await Promise.all(participants.map((participant, index) =>
      h.platform.applyAction(participant, `concurrent-${index}`, { type: 'limit', side: 'buy', price: 1, quantity: 1 })));
    assert.equal(h.platform.rooms.size, 6);
    assert.equal([...h.platform.rooms.values()].reduce((sum, room) => sum + room.engine.state.orders.length, 0), 75);
    assert.equal(h.platform.instructorState().health.unhealthyRooms, 0);
    for (const participant of participants) {
      const room = h.platform.rooms.get(participant.roomId);
      const resources = room.engine.availableResources(participant.id);
      assert.equal(resources.reservedCash, 1);
      assert.equal(resources.availableBuyQuantity, 9);
    }
  } finally { h.close(); }
});

test('trading controller transitions cancel orders and never grant a student seat server-liquidity status', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Controlled trader' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Other trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    await h.platform.applyAction(participant, 'before-takeover',
      { type: 'limit', side: 'buy', price: 1, quantity: 1 }, 0);
    assert.equal(room.engine.state.orders.some((order) => order.playerId === participant.id), true);

    await h.platform.replaceWithBot(participant.id, true);
    assert.equal(room.participantPlayer(participant.id).accountKind, 'student');
    assert.equal(room.engine.state.orders.some((order) => order.playerId === participant.id), false);
    room.engine.act(participant.id, { type: 'limit', side: 'buy', price: 1, quantity: 1 });
    assert.equal(room.engine.state.orders.find((order) => order.playerId === participant.id).ownerKind, 'student');

    h.platform.setConnected(participant.id, true);
    await h.platform.replaceWithBot(participant.id, false);
    assert.equal(room.engine.state.orders.some((order) => order.playerId === participant.id), false);
  } finally { h.close(); }
});

test('each trading table tick persists at most one automated order', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 300 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Bounded bot flow' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    const before = h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'bot_order').length;

    for (let tick = 0; tick < 5; tick += 1) await h.platform.tick();

    const automated = h.db.events(h.platform.session.id, room.id)
      .filter((event) => event.type === 'bot_order').slice(before);
    assert.equal(automated.length, 5);
    assert.equal(new Set(automated.map((event) => event.actor_id)).size, 5);
  } finally { h.close(); }
});

test('pause freezes a trading clock and strips actions until resume', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 30 });
    const joined = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Trader' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(joined.token);
    const room = h.platform.rooms.get(participant.roomId);
    await h.platform.pauseSession();
    assert.ok(room.engine.state.pausedAt);
    const frozen = room.engine.secondsRemaining();
    assert.equal(h.platform.studentSnapshot(participant).room.state.legalActions.length, 0);
    assert.equal(room.engine.secondsRemaining(), frozen);
    await h.platform.resumeSession();
    assert.equal(room.engine.state.pausedAt, null);
    assert.equal(h.platform.session.state, 'running');
    assert.ok(h.platform.studentSnapshot(participant).room.state.legalActions.length > 0);
  } finally { h.close(); }
});

test('pause and resume update every trading table atomically and remain retryable', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'live', duration: 300 });
    for (let index = 1; index <= 16; index += 1) {
      h.platform.join({ joinCode: h.platform.session.joinCode, name: `Clock ${index}` });
    }
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    assert.equal(rooms.length, 2);
    const beforeRows = clone(h.db.rooms(h.platform.session.id));
    const originalSave = h.db.saveRoom.bind(h.db);
    let pauseSaves = 0;
    let pauseTripped = false;
    h.db.saveRoom = (room, state) => {
      if (!pauseTripped && h.platform.session.state === 'paused' && ++pauseSaves === 2) {
        pauseTripped = true;
        throw new Error('Injected second-table pause failure');
      }
      return originalSave(room, state);
    };
    await assert.rejects(() => h.platform.pauseSession(), /Injected second-table pause failure/);
    assert.equal(h.platform.session.state, 'running');
    assert.ok(rooms.every((room) => room.engine.state.pausedAt === null));
    assert.deepEqual(clone(h.db.rooms(h.platform.session.id)), beforeRows);

    await h.platform.pauseSession();
    assert.equal(h.platform.session.state, 'paused');
    const sharedPausedAt = rooms[0].engine.state.pausedAt;
    assert.ok(sharedPausedAt);
    assert.ok(rooms.every((room) => room.engine.state.pausedAt === sharedPausedAt));

    const saveAfterPause = h.db.saveRoom.bind(h.db);
    let resumeSaves = 0;
    let resumeTripped = false;
    h.db.saveRoom = (room, state) => {
      if (!resumeTripped && h.platform.session.state === 'running' && ++resumeSaves === 2) {
        resumeTripped = true;
        throw new Error('Injected second-table resume failure');
      }
      return saveAfterPause(room, state);
    };
    await assert.rejects(() => h.platform.resumeSession(), /Injected second-table resume failure/);
    assert.equal(h.platform.session.state, 'paused');
    assert.ok(rooms.every((room) => room.engine.state.pausedAt === sharedPausedAt));
    await h.platform.resumeSession();
    assert.equal(h.platform.session.state, 'running');
    assert.ok(rooms.every((room) => room.engine.state.pausedAt === null));
  } finally { h.close(); }
});

test('pause and resume transition snapshots have strictly increasing persisted revisions', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 300 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Revision trader' });
    await h.platform.startSession();
    const room = [...h.platform.rooms.values()][0];
    const observed = [];
    h.platform.onBroadcast = ({ target }) => {
      if (target !== 'instructor') return;
      const snapshot = h.platform.instructorState();
      observed.push({ revision: snapshot.revision, state: snapshot.session.state });
    };

    let releasePause;
    room.queue = new Promise((resolve) => { releasePause = resolve; });
    const beforePause = h.platform.revision;
    const pausing = h.platform.pauseSession();
    assert.deepEqual(observed.at(-1), { revision: beforePause + 1, state: 'pausing' });
    assert.equal(h.db.getOrCreateSetting('snapshot_revision', () => '-1'), String(beforePause + 1));
    releasePause();
    await pausing;
    const pausedSnapshot = observed.at(-1);
    assert.equal(pausedSnapshot.state, 'paused');
    assert.ok(pausedSnapshot.revision > beforePause + 1);

    let releaseResume;
    room.queue = new Promise((resolve) => { releaseResume = resolve; });
    const resuming = h.platform.resumeSession();
    const resumingSnapshot = observed.at(-1);
    assert.equal(resumingSnapshot.state, 'resuming');
    assert.ok(resumingSnapshot.revision > pausedSnapshot.revision);
    releaseResume();
    await resuming;
    const runningSnapshot = observed.at(-1);
    assert.equal(runningSnapshot.state, 'running');
    assert.ok(runningSnapshot.revision > resumingSnapshot.revision);
    assert.equal(h.db.getOrCreateSetting('snapshot_revision', () => '-1'), String(runningSnapshot.revision));

    const successfulStates = observed.map((snapshot) => snapshot.state);
    assert.deepEqual(successfulStates, ['pausing', 'paused', 'resuming', 'running']);
    assert.equal(new Set(observed.map((snapshot) => snapshot.revision)).size, observed.length);

    const originalSave = h.db.saveRoom.bind(h.db);
    let tripped = false;
    h.db.saveRoom = (candidate, state) => {
      if (!tripped && h.platform.session.state === 'paused') {
        tripped = true;
        throw new Error('Injected pause revision rollback');
      }
      return originalSave(candidate, state);
    };
    const beforeFailedPause = h.platform.revision;
    await assert.rejects(() => h.platform.pauseSession(), /Injected pause revision rollback/);
    assert.equal(h.platform.session.state, 'running');
    assert.deepEqual(observed.slice(-2).map((snapshot) => snapshot.state), ['pausing', 'running']);
    assert.ok(observed.at(-2).revision > beforeFailedPause);
    assert.ok(observed.at(-1).revision > observed.at(-2).revision);
    assert.equal(h.db.getOrCreateSetting('snapshot_revision', () => '-1'), String(observed.at(-1).revision));
  } finally { h.close(); }
});

test('a trading tick queued before pause cannot run after the pause barrier', async () => {
  const h = harness();
  try {
    clearInterval(h.platform.timer);
    h.platform.createSession({ game: 'trading', mode: 'strategy', duration: 300 });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Barrier A' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Barrier B' });
    await h.platform.startSession();
    const rooms = [...h.platform.rooms.values()];
    const botOrdersBefore = rooms.map((room) =>
      h.db.events(h.platform.session.id, room.id).filter((event) => event.type === 'bot_order').length);
    let releaseFirstRoom;
    rooms[0].queue = new Promise((resolve) => { releaseFirstRoom = resolve; });
    const ticking = h.platform.tick();
    await Promise.resolve();
    const pausing = h.platform.pauseSession();
    assert.equal(h.platform.session.state, 'pausing');
    releaseFirstRoom();
    await Promise.all([ticking, pausing]);
    assert.equal(h.platform.session.state, 'paused');
    for (let index = 0; index < rooms.length; index += 1) {
      const botOrdersAfter = h.db.events(h.platform.session.id, rooms[index].id)
        .filter((event) => event.type === 'bot_order').length;
      assert.equal(botOrdersAfter, botOrdersBefore[index]);
    }
  } finally { h.close(); }
});

test('instructor bot substitution blocks the student seat and is auditable', async () => {
  const h = harness();
  try {
    h.platform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const first = h.platform.join({ joinCode: h.platform.session.joinCode, name: 'First' });
    h.platform.join({ joinCode: h.platform.session.joinCode, name: 'Second' });
    await h.platform.startSession();
    const participant = h.platform.authenticate(first.token);
    const broadcasts = [];
    h.platform.onBroadcast = (message) => broadcasts.push(message);
    await h.platform.replaceWithBot(participant.id, true);
    const replacedSnapshot = h.platform.studentSnapshot(participant);
    assert.equal(replacedSnapshot.room.seatControlledByBot, true);
    assert.equal(replacedSnapshot.room.state.legalActions.length, 0);
    assert.ok(broadcasts.some((message) => message.target === participant.id && message.type === 'room_update'));
    await assert.rejects(() => h.platform.applyAction(participant, 'human-while-replaced', { type: 'play', choice: 'rock' }), /controlled by a bot/);
    await assert.rejects(
      () => h.platform.replaceWithBot(participant.id, false),
      (error) => error.status === 409 && /must reconnect/i.test(error.message),
    );
    h.platform.setConnected(participant.id, true);
    await h.platform.replaceWithBot(participant.id, false);
    assert.equal(h.platform.studentSnapshot(participant).room.seatControlledByBot, false);
    const eventTypes = h.db.events(h.platform.session.id, participant.roomId).map((event) => event.type);
    assert.ok(eventTypes.includes('participant_replaced_by_bot'));
    assert.ok(eventTypes.includes('participant_restored'));
    await h.platform.endSession();
    assert.doesNotThrow(() => verifyExport(h.db, h.platform.classAudit()));
  } finally { h.close(); }
});

test('bot takeover epochs persist, duplicate transitions are idempotent, and queued stale actions stay rejected', async () => {
  const h = harness();
  let currentDb = h.db;
  let currentPlatform = h.platform;
  let originalClosed = false;
  try {
    currentPlatform.createSession({ game: 'rps', mode: 'live', rounds: 10 });
    const first = currentPlatform.join({ joinCode: currentPlatform.session.joinCode, name: 'Epoch student' });
    currentPlatform.join({ joinCode: currentPlatform.session.joinCode, name: 'Epoch opponent' });
    await currentPlatform.startSession();
    let participant = currentPlatform.authenticate(first.token);
    let room = currentPlatform.rooms.get(participant.roomId);
    let eventsOf = (type) => currentDb.events(currentPlatform.session.id, room.id).filter((event) => event.type === type);
    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 0);

    await currentPlatform.replaceWithBot(participant.id, true);
    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 1);
    assert.equal(eventsOf('participant_replaced_by_bot').length, 1);
    await currentPlatform.replaceWithBot(participant.id, true);
    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 1, 'duplicate takeover must not advance the epoch');
    assert.equal(eventsOf('participant_replaced_by_bot').length, 1, 'duplicate takeover must not emit another event');

    currentPlatform.close();
    currentDb.close();
    originalClosed = true;
    currentDb = new Database(h.filename);
    currentPlatform = new Platform(currentDb);
    await currentPlatform.startupRecovery;
    participant = currentPlatform.authenticate(first.token);
    room = currentPlatform.rooms.get(participant.roomId);
    eventsOf = (type) => currentDb.events(currentPlatform.session.id, room.id).filter((event) => event.type === type);
    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 1, 'takeover epoch must survive restart');
    assert.equal(currentPlatform.studentSnapshot(participant).room.seatControlledByBot, true);
    assert.equal(currentPlatform.session.state, 'paused');
    await currentPlatform.resumeSession();

    await assert.rejects(
      () => currentPlatform.replaceWithBot(participant.id, false),
      (error) => error.status === 409 && /must reconnect/i.test(error.message),
    );
    currentPlatform.setConnected(participant.id, true);

    let releaseRoom;
    room.queue = new Promise((resolve) => { releaseRoom = resolve; });
    const restoring = currentPlatform.replaceWithBot(participant.id, false);
    const staleAction = currentPlatform.applyAction(
      participant,
      'queued-before-restore-screen',
      { type: 'play', choice: 'rock' },
      1,
    );
    const staleRejected = assert.rejects(staleAction, /Stale action|controlled by a bot/);
    releaseRoom();
    await Promise.all([restoring, staleRejected]);

    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 2);
    assert.equal(eventsOf('participant_restored').length, 1);
    assert.equal(currentDb.actionExists(room.id, 'queued-before-restore-screen'), false);
    await currentPlatform.replaceWithBot(participant.id, false);
    assert.equal(currentPlatform.studentSnapshot(participant).actionEpoch, 2, 'duplicate restore must not advance the epoch');
    assert.equal(eventsOf('participant_restored').length, 1, 'duplicate restore must not emit another event');

    currentPlatform.close();
    currentDb.close();
    currentDb = new Database(h.filename);
    currentPlatform = new Platform(currentDb);
    await currentPlatform.startupRecovery;
    const restoredParticipant = currentPlatform.authenticate(first.token);
    assert.equal(currentPlatform.studentSnapshot(restoredParticipant).actionEpoch, 2, 'restore epoch must survive restart');
    assert.equal(currentPlatform.studentSnapshot(restoredParticipant).room.seatControlledByBot, false);
    assert.equal(currentDb.events(currentPlatform.session.id, restoredParticipant.roomId)
      .filter((event) => event.type === 'participant_replaced_by_bot').length, 1);
    assert.equal(currentDb.events(currentPlatform.session.id, restoredParticipant.roomId)
      .filter((event) => event.type === 'participant_restored').length, 1);
  } finally {
    if (originalClosed) {
      currentPlatform?.close();
      currentDb?.close();
      fs.rmSync(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } else {
      h.close();
    }
  }
});

for (const [game, expectedRooms, tableSize] of [
  ['rps', 38, 2], ['liars_dice', 15, 5], ['blackjack', 15, 5], ['poker', 15, 5], ['trading', 6, 15]
]) {
  test(`${game} live mode assigns 75 students to bounded classroom tables`, async () => {
    const h = harness();
    try {
      h.platform.createSession({ game, mode: 'live', rounds: game === 'rps' ? 10 : 3, duration: 30 });
      for (let index = 1; index <= 75; index += 1) {
        h.platform.join({ joinCode: h.platform.session.joinCode, name: `Student ${index}` });
      }
      await h.platform.startSession();
      assert.equal(h.platform.participants.size, 75);
      assert.equal(h.platform.rooms.size, expectedRooms);
      if (game === 'trading') {
        assert.ok([...h.platform.rooms.values()].every((room) => room.players.length <= tableSize));
        assert.ok([...h.platform.rooms.values()].every((room) =>
          room.players.filter((player) => player.isBot).length === 1 &&
          room.players.find((player) => player.isBot)?.botKind === 'market_maker'));
      } else {
        assert.ok([...h.platform.rooms.values()].every((room) => room.players.length === tableSize));
      }
      assert.ok([...h.platform.participants.values()].every((participant) => participant.roomId));
      assert.equal(h.platform.instructorState().health.unhealthyRooms, 0);
    } finally { h.close(); }
  });
}
