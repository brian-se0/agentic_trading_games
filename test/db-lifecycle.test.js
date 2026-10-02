import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  auditPublicKeyFromDataKey,
  Database,
  defaultDatabasePath,
  migrateLegacyDatabaseEncryption,
  protectedAppDataDirectory,
} from '../src/db.js';
import { AuditRandom } from '../src/random.js';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function v1Envelope(table, column, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce);
  cipher.setAAD(Buffer.from(`agentic-trading-games:v1:${table}:${column}`));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `enc:v1:${nonce.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

function dropIntegrityTriggers(db, table = null) {
  const pattern = table == null ? 'agentic_integrity_%' : `agentic_integrity_${table}_%`;
  const triggers = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE ? ESCAPE '\\' ORDER BY name",
  ).all(pattern);
  for (const { name } of triggers) {
    if (!/^agentic_integrity_[a-z_]+_(?:insert|update|delete)$/.test(name)) {
      throw new Error(`Unexpected integrity trigger ${name}`);
    }
    db.exec(`DROP TRIGGER "${name}"`);
  }
  return triggers;
}

function restoreTriggers(db, triggers) {
  for (const { sql } of triggers) db.exec(sql);
}

function removeIntegrityMetadata(db) {
  dropIntegrityTriggers(db);
  db.exec('DROP TABLE IF EXISTS row_integrity; DROP TABLE IF EXISTS integrity_manifest;');
}

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-lifecycle-'));
  const filename = path.join(directory, 'data', 'class.sqlite');
  const db = new Database(filename, { encryptionKey: KEY });
  return {
    db, filename, directory,
    close() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function insertSession(db, id = 'session_one', state = 'lobby', createdAt = '2026-01-01T00:00:00.000Z') {
  db.insertSession({
    id, joinCode: id === 'session_one' ? '123456' : '654321', state, game: 'rps', mode: 'live',
    config: { rounds: 10 }, createdAt, updatedAt: createdAt, completedAt: null,
  });
}

test('protected app-data paths are per-user on each supported desktop family', () => {
  assert.equal(
    protectedAppDataDirectory({ platform: 'win32', environment: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, homeDirectory: 'ignored' }),
    path.join('C:\\Users\\Ada\\AppData\\Local', 'Agentic Trading Games'),
  );
  assert.equal(
    defaultDatabasePath({ platform: 'darwin', environment: {}, homeDirectory: '/Users/ada' }),
    '/Users/ada/Library/Application Support/Agentic Trading Games/agentic-games.sqlite',
  );
  assert.equal(
    defaultDatabasePath({ platform: 'linux', environment: { XDG_DATA_HOME: '/home/ada/.data' }, homeDirectory: '/home/ada' }),
    '/home/ada/.data/agentic-trading-games/agentic-games.sqlite',
  );
});

test('audit signing identity is stable for one protected data key and distinct across installations', () => {
  const h = harness();
  try {
    const publicKey = auditPublicKeyFromDataKey(KEY);
    assert.equal(h.db.auditPublicKey(), publicKey);
    const root = 'ab'.repeat(32);
    const signed = h.db.signAuditRoot('session_one', root);
    const message = Buffer.from(`agentic-trading-games:audit-root-signature:v1\0session_one\0${root}`);
    assert.equal(crypto.verify(null, message, crypto.createPublicKey(publicKey), Buffer.from(signed.signature, 'base64url')), true);
    assert.notEqual(auditPublicKeyFromDataKey(crypto.randomBytes(32)), publicKey);
    assert.equal(signed.keyFingerprint,
      crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ format: 'der', type: 'spki' })).digest('hex'));
  } finally { h.close(); }
});

test('event chain commits JSON fields named __proto__', () => {
  const h = harness();
  try {
    insertSession(h.db);
    h.db.event({
      sessionId: 'session_one', type: 'session_created',
      payload: JSON.parse('{"ordinary":1,"__proto__":{"signed":true}}'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const [event] = h.db.events('session_one');
    assert.equal(event.payload_json, '{"__proto__":{"signed":true},"ordinary":1}');
    assert.equal(Object.hasOwn(JSON.parse(event.payload_json), '__proto__'), true);
    assert.equal(h.db.verifyEventChain('session_one').valid, true);
  } finally { h.close(); }
});

test('event writes enforce the versioned room and session scope vocabulary', () => {
  const h = harness();
  try {
    insertSession(h.db);
    insertSession(h.db, 'session_two', 'lobby', '2026-01-01T00:00:01.000Z');
    const seed = '44'.repeat(32);
    h.db.saveRoom({
      id: 'room_one', sessionId: 'session_one', ordinal: 0, game: 'rps', mode: 'live',
      status: 'running', sequence: 0, seedCommitment: hash(Buffer.from(seed, 'hex')),
      rng: new AuditRandom(seed), players: [], actionEpochs: new Map(),
    }, { round: 0 });
    const integrityBefore = h.db.verifyDatabaseIntegrity();

    assert.throws(() => h.db.event({
      sessionId: 'session_one', type: 'student_action', payload: {},
    }), /Room event room id is required/);
    assert.throws(() => h.db.event({
      sessionId: 'session_one', roomId: '', sequence: 1, type: 'student_action', payload: {},
    }), /Room event room id is required/);
    assert.throws(() => h.db.event({
      sessionId: 'session_one', roomId: 'room_one', sequence: 1, type: 'participant_joined', payload: {},
    }), /must have null room and sequence/);
    assert.throws(() => h.db.event({
      sessionId: 'session_two', roomId: 'room_one', sequence: 1, type: 'room_created', payload: {},
    }), /same session/);
    assert.throws(() => h.db.event({
      sessionId: 'session_one', type: 'unversioned_event', payload: {},
    }), /Unsupported event type/);
    assert.equal(h.db.events('session_one').length, 0);
    assert.equal(h.db.events('session_two').length, 0);
    assert.deepEqual(h.db.verifyDatabaseIntegrity(), integrityBefore);
  } finally { h.close(); }
});

test('roster redemption binds identity, encrypts sensitive fields, and enforces auth lifetime', () => {
  const h = harness();
  try {
    insertSession(h.db);
    const [invitation] = h.db.createRosterEntries('session_one', [{
      id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student', inviteHash: hash('invite-secret'),
      createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    assert.equal(invitation.identity_key, 'student-0001');
    const rawInvitation = h.db.db.prepare('SELECT * FROM roster_entries WHERE id=?').get('invite_one');
    assert.match(rawInvitation.identity_key, /^enc:v2:/);
    assert.match(rawInvitation.display_name, /^enc:v2:/);
    assert.doesNotMatch(rawInvitation.identity_key, /student-0001/);

    const participantTokenHash = hash('participant-secret');
    h.db.transaction(() => {
      const redeemed = h.db.redeemRosterInvite('invite_one', {
        id: 'participant_one', sessionId: 'session_one', tokenHash: participantTokenHash,
        authExpiresAt: '2026-01-01T12:00:00.000Z', connected: true,
        createdAt: '2026-01-01T01:00:00.000Z',
      });
      assert.equal(redeemed.participant.name, 'Ada Student');
      assert.equal(redeemed.participant.roster_identity, 'student-0001');
      h.db.event({ sessionId: 'session_one', actorId: 'participant_one', type: 'participant_joined', payload: { name: 'Ada Student' },
        createdAt: '2026-01-01T01:00:00.000Z' });
    });
    assert.equal(h.db.participantByTokenHash(participantTokenHash, '2026-01-01T11:59:59.000Z').id, 'participant_one');
    assert.equal(h.db.participantByTokenHash(participantTokenHash, '2026-01-01T12:00:00.000Z'), undefined);
    assert.equal(h.db.rosterEntryByInviteHash(hash('invite-secret')), undefined);
    assert.equal(h.db.verifyEventChain('session_one').valid, true);
    h.db.db.prepare("UPDATE events SET type='tampered' WHERE session_id=?").run('session_one');
    assert.equal(h.db.verifyEventChain('session_one').valid, false);
    h.db.db.prepare("UPDATE events SET type='participant_joined' WHERE session_id=?").run('session_one');
    assert.equal(h.db.verifyEventChain('session_one').valid, true);
    assert.match(h.db.db.prepare('SELECT name FROM participants WHERE id=?').get('participant_one').name, /^enc:v2:/);
    assert.match(h.db.db.prepare('SELECT payload_json FROM events WHERE session_id=?').get('session_one').payload_json, /^enc:v2:/);

    h.db.createStudentWebSession({
      idHash: hash('cookie-id'), participantId: 'participant_one', csrfHash: hash('csrf'),
      createdAt: '2026-01-01T02:00:00.000Z', expiresAt: '2026-01-01T03:00:00.000Z',
    });
    assert.equal(h.db.studentWebSession(hash('cookie-id'), '2026-01-01T02:30:00.000Z').participant_id, 'participant_one');
    h.db.revokeParticipantToken('participant_one', '2026-01-01T02:45:00.000Z');
    assert.equal(h.db.studentWebSession(hash('cookie-id'), '2026-01-01T02:46:00.000Z'), undefined);
  } finally { h.close(); }
});

test('row-bound roster ciphertext cannot be swapped to change an invite identity', () => {
  const h = harness();
  try {
    insertSession(h.db);
    h.db.createRosterEntries('session_one', [
      {
        id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student',
        inviteHash: hash('invite-secret-one'), createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'invite_two', identityKey: 'student-0002', displayName: 'Grace Student',
        inviteHash: hash('invite-secret-two'), createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);
    const original = new Map(h.db.db.prepare(
      'SELECT id, identity_key, display_name FROM roster_entries ORDER BY id',
    ).all().map((row) => [row.id, row]));
    const first = original.get('invite_one');
    const second = original.get('invite_two');
    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run('swap-temporary', 'invite_one');
    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run(first.identity_key, 'invite_two');
    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run(second.identity_key, 'invite_one');

    assert.throws(() => h.db.redeemRosterInvite('invite_one', {
      id: 'participant_one', tokenHash: hash('participant-secret'), connected: true,
      createdAt: '2026-01-01T01:00:00.000Z', authExpiresAt: '2026-01-01T12:00:00.000Z',
    }), /could not be authenticated/);
    assert.equal(h.db.db.prepare('SELECT COUNT(*) AS count FROM participants').get().count, 0);
    const untouched = h.db.db.prepare(
      'SELECT redeemed_at, participant_id FROM roster_entries WHERE id=?',
    ).get('invite_one');
    assert.equal(untouched.redeemed_at, null);
    assert.equal(untouched.participant_id, null);

    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run('restore-temporary', 'invite_one');
    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run(second.identity_key, 'invite_two');
    h.db.db.prepare('UPDATE roster_entries SET identity_key=? WHERE id=?').run(first.identity_key, 'invite_one');

    const firstInviteHash = hash('invite-secret-one');
    const secondInviteHash = hash('invite-secret-two');
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(hash('swap-temporary'), 'invite_one');
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(firstInviteHash, 'invite_two');
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(secondInviteHash, 'invite_one');
    assert.throws(() => h.db.rosterEntryByInviteHash(firstInviteHash), /could not be authenticated/);
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(hash('restore-temporary'), 'invite_one');
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(secondInviteHash, 'invite_two');
    h.db.db.prepare('UPDATE roster_entries SET invite_hash=? WHERE id=?').run(firstInviteHash, 'invite_one');

    const redeemed = h.db.redeemRosterInvite('invite_one', {
      id: 'participant_one', tokenHash: hash('participant-secret'), connected: true,
      createdAt: '2026-01-01T01:00:00.000Z', authExpiresAt: '2026-01-01T12:00:00.000Z',
    });
    assert.equal(redeemed.participant.roster_identity, 'student-0001');
    assert.equal(redeemed.participant.name, 'Ada Student');
  } finally { h.close(); }
});

test('student web-session ownership is keyed and cannot be reassigned to another participant', () => {
  const h = harness();
  try {
    insertSession(h.db);
    for (const [id, token] of [['participant_one', 'token-one'], ['participant_two', 'token-two']]) {
      h.db.insertParticipant({
        id, sessionId: 'session_one', name: id, rosterIdentity: id,
        tokenHash: hash(token), connected: false, createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    h.db.createStudentWebSession({
      idHash: hash('cookie-id'), participantId: 'participant_one', csrfHash: hash('csrf'),
      createdAt: '2026-01-01T01:00:00.000Z', expiresAt: '2026-01-01T02:00:00.000Z',
    });
    const stored = h.db.db.prepare('SELECT * FROM web_sessions').get();
    assert.match(stored.binding_hash, /^[a-f0-9]{64}$/);
    h.db.db.exec('DROP TRIGGER protect_web_sessions_binding');
    h.db.db.prepare('UPDATE web_sessions SET participant_id=? WHERE session_hash=?')
      .run('participant_two', hash('cookie-id'));
    assert.throws(
      () => h.db.studentWebSession(hash('cookie-id'), '2026-01-01T01:30:00.000Z'),
      /integrity manifest could not be verified|ownership binding could not be authenticated/,
    );
  } finally { h.close(); }
});

test('keyed row integrity rejects a live roster edit before invitation lookup', () => {
  const h = harness();
  try {
    insertSession(h.db);
    h.db.createRosterEntries('session_one', [{
      id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student',
      inviteHash: hash('invite-secret'), createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    dropIntegrityTriggers(h.db.db, 'roster_entries');
    h.db.db.prepare('UPDATE roster_entries SET display_name=? WHERE id=?').run('Forged Name', 'invite_one');
    assert.throws(
      () => h.db.rosterEntryByInviteHash(hash('invite-secret')),
      /integrity manifest could not be verified|row integrity could not be authenticated/,
    );
  } finally { h.close(); }
});

test('authenticated set manifest detects deletion of a complete encrypted row', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-set-integrity-'));
  const filename = path.join(directory, 'class.sqlite');
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    initial.decision({
      sessionId: 'session_one', roomId: 'room_one', playerId: 'participant_one', game: 'rps',
      context: { round: 1 }, legal: ['rock'], action: { move: 'rock' }, benchmark: { move: 'rock' },
      outcome: { score: 1 }, createdAt: '2026-01-01T01:00:00.000Z',
    });
    initial.close();

    const raw = new DatabaseSync(filename);
    dropIntegrityTriggers(raw, 'decisions');
    raw.exec('DELETE FROM decisions');
    raw.close();
    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /schema manifest could not be authenticated|orphaned row records|set manifest does not match/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema preflight rejects an injected trigger before keyed functions or application writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-schema-trigger-'));
  const filename = path.join(directory, 'class.sqlite');
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    initial.insertParticipant({
      id: 'participant_one', sessionId: 'session_one', name: 'Revoked Student',
      rosterIdentity: 'student-0001', tokenHash: hash('revoked-token'), connected: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    initial.revokeParticipantToken('participant_one', '2026-01-01T01:00:00.000Z');
    initial.close();

    const raw = new DatabaseSync(filename);
    raw.exec(`CREATE TRIGGER attacker_reenable_auth AFTER UPDATE ON sessions BEGIN
      UPDATE participants SET auth_revoked_at=NULL, competitive_eligible=1
      WHERE id='participant_one';
    END`);
    raw.close();

    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /unexpected trigger attacker_reenable_auth/,
    );
    const unchanged = new DatabaseSync(filename);
    const participant = unchanged.prepare(
      'SELECT auth_revoked_at, competitive_eligible FROM participants WHERE id=?',
    ).get('participant_one');
    assert.equal(participant.auth_revoked_at, '2026-01-01T01:00:00.000Z');
    assert.equal(participant.competitive_eligible, 0);
    unchanged.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema digest rejects a malicious replacement under an allowed trigger name', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-schema-trigger-replacement-'));
  const filename = path.join(directory, 'class.sqlite');
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    initial.close();

    const raw = new DatabaseSync(filename);
    raw.exec(`DROP TRIGGER agentic_integrity_sessions_update;
      CREATE TRIGGER agentic_integrity_sessions_update AFTER UPDATE ON sessions BEGIN
        UPDATE sessions SET state='completed' WHERE id=NEW.id;
      END`);
    raw.close();

    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /schema manifest could not be authenticated/,
    );
    const unchanged = new DatabaseSync(filename);
    assert.equal(unchanged.prepare('SELECT state FROM sessions WHERE id=?').get('session_one').state, 'lobby');
    unchanged.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('v1 envelopes migrate in place to row-bound v2 envelopes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-v1-migration-'));
  const filename = path.join(directory, 'class.sqlite');
  let migrated;
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    initial.createRosterEntries('session_one', [{
      id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student',
      inviteHash: hash('invite-secret'), createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    initial.close();

    const raw = new DatabaseSync(filename);
    removeIntegrityMetadata(raw);
    raw.prepare('UPDATE sessions SET config_json=? WHERE id=?')
      .run(v1Envelope('sessions', 'config_json', '{"rounds":10}'), 'session_one');
    raw.prepare('UPDATE roster_entries SET identity_key=?, display_name=? WHERE id=?').run(
      v1Envelope('roster_entries', 'identity_key', 'student-0001'),
      v1Envelope('roster_entries', 'display_name', 'Ada Student'),
      'invite_one',
    );
    raw.prepare('UPDATE app_settings SET value=? WHERE key=?').run(
      v1Envelope('app_settings', 'value', 'agentic-trading-games:aes-256-gcm:v1'),
      '__database_encryption_key_check_v1',
    );
    raw.close();

    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /migrate-database-encryption/,
    );
    const beforeMigration = new DatabaseSync(filename);
    assert.match(beforeMigration.prepare('SELECT config_json FROM sessions WHERE id=?').get('session_one').config_json, /^enc:v1:/);
    beforeMigration.close();
    assert.deepEqual(
      migrateLegacyDatabaseEncryption(filename, { encryptionKey: KEY }),
      { migrated: true, envelopeVersion: 2 },
    );
    migrated = new Database(filename, { encryptionKey: KEY });
    assert.deepEqual(JSON.parse(migrated.session('session_one').config_json), { rounds: 10 });
    assert.equal(migrated.rosterEntry('invite_one').identity_key, 'student-0001');
    assert.equal(migrated.rosterEntry('invite_one').display_name, 'Ada Student');
    const envelopes = migrated.db.prepare(`SELECT sessions.config_json, roster_entries.identity_key,
      roster_entries.display_name FROM sessions JOIN roster_entries
      ON roster_entries.session_id=sessions.id WHERE roster_entries.id=?`).get('invite_one');
    for (const value of Object.values(envelopes)) assert.match(value, /^enc:v2:/);
  } finally {
    migrated?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('v1 envelope migration rolls back every rewrite when any row fails authentication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-v1-rollback-'));
  const filename = path.join(directory, 'class.sqlite');
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    initial.createRosterEntries('session_one', [{
      id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student',
      inviteHash: hash('invite-secret'), createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    initial.close();

    const configV1 = v1Envelope('sessions', 'config_json', '{"rounds":10}');
    const identityParts = v1Envelope('roster_entries', 'identity_key', 'student-0001').split(':');
    const tag = Buffer.from(identityParts[4], 'base64url');
    tag[0] ^= 0x01;
    identityParts[4] = tag.toString('base64url');
    const raw = new DatabaseSync(filename);
    removeIntegrityMetadata(raw);
    raw.prepare('UPDATE sessions SET config_json=? WHERE id=?').run(configV1, 'session_one');
    raw.prepare('UPDATE roster_entries SET identity_key=?, display_name=? WHERE id=?').run(
      identityParts.join(':'), v1Envelope('roster_entries', 'display_name', 'Ada Student'), 'invite_one',
    );
    raw.prepare('UPDATE app_settings SET value=? WHERE key=?').run(
      v1Envelope('app_settings', 'value', 'agentic-trading-games:aes-256-gcm:v1'),
      '__database_encryption_key_check_v1',
    );
    raw.close();

    assert.throws(
      () => migrateLegacyDatabaseEncryption(filename, { encryptionKey: KEY }),
      /could not be authenticated/,
    );
    const afterFailure = new DatabaseSync(filename);
    assert.equal(afterFailure.prepare('SELECT config_json FROM sessions WHERE id=?').get('session_one').config_json, configV1);
    assert.equal(afterFailure.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    afterFailure.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normal startup rejects forged plaintext room state without rewriting or trusting it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-plaintext-tamper-'));
  const filename = path.join(directory, 'class.sqlite');
  const forgedState = '{"score":999999,"winner":"attacker"}';
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    const seed = '22'.repeat(32);
    initial.saveRoom({
      id: 'room_one', sessionId: 'session_one', ordinal: 0, game: 'rps', mode: 'live',
      status: 'running', sequence: 0, seedCommitment: hash(Buffer.from(seed, 'hex')),
      rng: new AuditRandom(seed), players: [], actionEpochs: new Map(),
    }, { score: 0, winner: null });
    initial.close();

    const raw = new DatabaseSync(filename);
    dropIntegrityTriggers(raw, 'rooms');
    raw.prepare('UPDATE rooms SET state_json=? WHERE id=?').run(forgedState, 'room_one');
    raw.close();

    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /schema manifest could not be authenticated|row integrity could not be authenticated/,
    );
    const withoutManifest = new DatabaseSync(filename);
    removeIntegrityMetadata(withoutManifest);
    withoutManifest.close();
    assert.throws(() => migrateLegacyDatabaseEncryption(filename, { encryptionKey: KEY }),
      /Refusing to migrate mixed protected-data generations/);
    const afterFailure = new DatabaseSync(filename);
    assert.equal(afterFailure.prepare('SELECT state_json FROM rooms WHERE id=?').get('room_one').state_json, forgedState);
    afterFailure.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('room snapshots reject stale same-row ciphertext and row-context replay against a newer event head', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-room-replay-'));
  const filename = path.join(directory, 'class.sqlite');
  try {
    const initial = new Database(filename, { encryptionKey: KEY });
    insertSession(initial);
    const seed = '33'.repeat(32);
    const room = {
      id: 'room_one', sessionId: 'session_one', ordinal: 0, game: 'rps', mode: 'live',
      status: 'running', sequence: 0, seedCommitment: hash(Buffer.from(seed, 'hex')),
      rng: new AuditRandom(seed), players: [], actionEpochs: new Map(),
    };
    initial.saveRoom(room, { round: 0, score: 0 });
    room.sequence = 1;
    initial.event({
      sessionId: 'session_one', roomId: 'room_one', sequence: 1,
      actorId: 'instructor', type: 'room_created', payload: {},
    });
    initial.saveRoom(room, { round: 1, score: 0 });
    const stale = initial.db.prepare(`SELECT sequence, rng_counter, seed_hex, players_json, state_json
      FROM rooms WHERE id=?`).get('room_one');
    room.sequence = 2;
    initial.event({
      sessionId: 'session_one', roomId: 'room_one', sequence: 2,
      actorId: 'participant_one', type: 'student_action', payload: { score: 1 },
    });
    initial.saveRoom(room, { round: 2, score: 1 });
    const current = initial.db.prepare(`SELECT sequence, rng_counter, seed_hex, players_json, state_json
      FROM rooms WHERE id=?`).get('room_one');
    initial.close();

    let raw = new DatabaseSync(filename);
    const roomIntegrityTriggers = dropIntegrityTriggers(raw, 'rooms');
    raw.prepare('UPDATE rooms SET seed_hex=?, players_json=?, state_json=? WHERE id=?')
      .run(stale.seed_hex, stale.players_json, stale.state_json, 'room_one');
    raw.close();
    assert.throws(() => new Database(filename, { encryptionKey: KEY }),
      /schema manifest could not be authenticated|row integrity could not be authenticated/);

    raw = new DatabaseSync(filename);
    raw.prepare('UPDATE rooms SET seed_hex=?, players_json=?, state_json=? WHERE id=?')
      .run(current.seed_hex, current.players_json, current.state_json, 'room_one');
    restoreTriggers(raw, roomIntegrityTriggers);
    raw.close();
    const verified = new Database(filename, { encryptionKey: KEY });
    verified.close();

    raw = new DatabaseSync(filename);
    dropIntegrityTriggers(raw, 'rooms');
    raw.exec('DROP TRIGGER protect_rooms_encryption_context');
    raw.prepare(`UPDATE rooms SET sequence=?, rng_counter=?, seed_hex=?, players_json=?, state_json=?
      WHERE id=?`).run(
      stale.sequence, stale.rng_counter, stale.seed_hex, stale.players_json, stale.state_json, 'room_one',
    );
    raw.close();
    assert.throws(
      () => new Database(filename, { encryptionKey: KEY }),
      /schema manifest could not be authenticated|row integrity could not be authenticated/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removed roster identity can redeem a rotated invitation without restoring eligibility', () => {
  const h = harness();
  try {
    insertSession(h.db);
    h.db.createRosterEntries('session_one', [{
      id: 'invite_one', identityKey: 'student-0001', displayName: 'Ada Student', inviteHash: hash('first-invite'),
    }]);
    h.db.redeemRosterInvite('invite_one', {
      id: 'participant_one', tokenHash: hash('first-token'), connected: false,
      createdAt: '2026-01-01T01:00:00.000Z', authExpiresAt: '2026-01-01T12:00:00.000Z',
    });
    h.db.removeParticipant('participant_one', '2026-01-01T02:00:00.000Z');
    h.db.rotateRosterInvite('invite_one', hash('second-invite'));
    const result = h.db.redeemRosterInvite('invite_one', {
      id: 'participant_two', tokenHash: hash('second-token'), connected: false,
      createdAt: '2026-01-01T03:00:00.000Z', authExpiresAt: '2026-01-01T12:00:00.000Z',
    });
    assert.equal(result.participant.roster_identity, 'student-0001');
    assert.equal(result.participant.competitive_eligible, 1);
    assert.throws(() => h.db.setParticipantCompetitiveEligible('participant_one', true), /permanent/);
  } finally { h.close(); }
});

test('controller and terminal result provenance are immutable and terminal purges are explicit', () => {
  const h = harness();
  try {
    insertSession(h.db);
    h.db.insertParticipant({
      id: 'participant_one', sessionId: 'session_one', name: 'Legacy Student', tokenHash: hash('legacy-token'),
      connected: false, createdAt: '2026-01-01T00:30:00.000Z',
    });
    const roomSeed = '11'.repeat(32);
    const room = {
      id: 'room_one', sessionId: 'session_one', ordinal: 0, game: 'rps', mode: 'live', status: 'running', sequence: 0,
      seedCommitment: hash(Buffer.from(roomSeed, 'hex')), rng: new AuditRandom(roomSeed),
      players: [{ id: 'participant_one', name: 'Legacy Student', isBot: false }],
      actionEpochs: new Map([['participant_one', 0]]),
    };
    h.db.saveRoom(room, { complete: false });
    room.status = 'completed';
    room.sequence = 1;
    h.db.event({ sessionId: 'session_one', roomId: 'room_one', sequence: 1, type: 'room_completed', payload: { score: 1 },
      createdAt: '2026-01-01T02:00:00.000Z' });
    h.db.saveRoom(room, { complete: true });
    const root = h.db.eventRoot('session_one', 'room_one');
    assert.match(root, /^[a-f0-9]{64}$/);
    assert.equal(h.db.room('room_one').transcript_root, root);

    h.db.recordControllerTransition({
      sessionId: 'session_one', roomId: 'room_one', participantId: 'participant_one', controller: 'system',
      reason: 'turn deadline', createdAt: '2026-01-01T01:30:00.000Z',
    });
    assert.equal(h.db.participant('participant_one').controller_provenance, 'mixed');
    assert.equal(h.db.controllerTransitions('session_one', 'participant_one')[0].reason, 'turn deadline');
    h.db.annotation({ sessionId: 'session_one', roomId: 'room_one', kind: 'review', note: 'Private instructor note' });
    assert.equal(h.db.annotations('session_one', 'room_one')[0].note, 'Private instructor note');
    assert.match(h.db.db.prepare('SELECT note FROM annotations').get().note, /^enc:v2:/);
    const provenance = h.db.recordResultProvenance({
      sessionId: 'session_one', roomId: 'room_one', playerId: 'participant_one', result: { score: 1 }, transcriptRoot: root,
      createdAt: '2026-01-01T02:00:00.000Z',
    });
    assert.equal(provenance.competitive_eligible, 0);
    assert.throws(() => h.db.recordResultProvenance({
      sessionId: 'session_one', roomId: 'room_one', playerId: 'participant_one', result: { score: 2 }, transcriptRoot: root,
    }), /immutable/);

    assert.throws(() => h.db.purgeSession('session_one', { compact: false }), /terminal/);
    h.db.updateSession({
      id: 'session_one', state: 'completed', game: 'rps', mode: 'live', config: { rounds: 10 },
      updatedAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T00:00:00.000Z',
    });
    const purge = h.db.purgeCompletedSessions({ before: '2026-02-01T00:00:00.000Z' });
    assert.equal(purge.sessions, 1);
    assert.equal(purge.counts.sessions, 1);
    assert.equal(h.db.session('session_one'), undefined);
  } finally { h.close(); }
});

test('database key is mandatory and a wrong key cannot open encrypted data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-key-'));
  const filename = path.join(directory, 'class.sqlite');
  const previous = process.env.AGENTIC_DATA_KEY;
  try {
    delete process.env.AGENTIC_DATA_KEY;
    assert.throws(() => new Database(filename), /32-byte database encryption key is required/);
    const db = new Database(filename, { encryptionKey: KEY });
    insertSession(db);
    db.close();
    assert.throws(() => new Database(filename, { encryptionKey: crypto.randomBytes(32) }), /could not be authenticated/);
    const reopened = new Database(filename, { encryptionKey: KEY });
    assert.deepEqual(JSON.parse(reopened.session('session_one').config_json), { rounds: 10 });
    reopened.close();
  } finally {
    if (previous == null) delete process.env.AGENTIC_DATA_KEY;
    else process.env.AGENTIC_DATA_KEY = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy plaintext schema migrates in place, encrypts fields, and backfills the event chain', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-db-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, join_code TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      game TEXT NOT NULL, mode TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE participants (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, room_id TEXT, is_connected INTEGER NOT NULL DEFAULT 0,
      removed_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), game TEXT NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, seed_commitment TEXT NOT NULL,
      seed_hex TEXT, rng_counter INTEGER NOT NULL DEFAULT 0, players_json TEXT NOT NULL, state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, room_id TEXT,
      sequence INTEGER, actor_id TEXT, type TEXT NOT NULL, visibility TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, room_id TEXT NOT NULL,
      player_id TEXT NOT NULL, game TEXT NOT NULL, context_json TEXT NOT NULL, legal_json TEXT NOT NULL,
      action_json TEXT NOT NULL, benchmark_json TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE accepted_actions (room_id TEXT NOT NULL REFERENCES rooms(id), action_id TEXT NOT NULL,
      player_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(room_id, action_id));
    CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, room_id TEXT,
      player_id TEXT, kind TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('legacy_session','111111','completed','rps','live','{"rounds":10}',
      '2025-01-01T00:00:00.000Z','2025-01-02T00:00:00.000Z','2025-01-02T00:00:00.000Z');
    INSERT INTO participants VALUES ('legacy_participant','legacy_session','Legacy Name',
      '${hash('legacy-auth')}',NULL,0,NULL,'2025-01-01T00:01:00.000Z');
    INSERT INTO events (session_id,actor_id,type,visibility,payload_json,created_at) VALUES
      ('legacy_session','legacy_participant','participant_joined','public','{"name":"Legacy Name"}','2025-01-01T00:02:00.000Z');
  `);
  legacy.close();
  let migrated;
  try {
    migrateLegacyDatabaseEncryption(filename, { encryptionKey: KEY });
    migrated = new Database(filename, { encryptionKey: KEY });
    assert.equal(migrated.participant('legacy_participant').name, 'Legacy Name');
    assert.equal(migrated.participant('legacy_participant').roster_identity, 'legacy:legacy_participant');
    assert.equal(migrated.verifyEventChain('legacy_session').valid, true);
    const raw = migrated.db.prepare(`SELECT participants.name, participants.roster_identity,
      sessions.config_json, events.payload_json, events.event_hash
      FROM participants JOIN sessions ON sessions.id=participants.session_id
      JOIN events ON events.session_id=sessions.id`).get();
    assert.match(raw.name, /^enc:v2:/);
    assert.match(raw.roster_identity, /^enc:v2:/);
    assert.match(raw.config_json, /^enc:v2:/);
    assert.match(raw.payload_json, /^enc:v2:/);
    assert.match(raw.event_hash, /^[a-f0-9]{64}$/);
  } finally {
    migrated?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
