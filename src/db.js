import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP_DATA_DIRECTORY = 'Agentic Trading Games';
const DATABASE_FILENAME = 'agentic-games.sqlite';
const EVENT_GENESIS_HASH = '0'.repeat(64);
const SESSION_EVENT_TYPES = new Set([
  'participant_joined',
  'participant_removed',
  'roster_entries_created',
  'roster_invitation_revoked',
  'roster_invitation_rotated',
  'seating_draw_committed',
  'seating_draw_revealed',
  'session_audit_sealed',
  'session_completed',
  'session_created',
  'session_ending',
  'session_paused',
  'session_paused_after_restart',
  'session_resumed',
  'session_started',
  'session_version_quarantined',
  'session_voided',
  'session_voiding',
]);
const ROOM_EVENT_TYPES = new Set([
  'bot_action',
  'bot_order',
  'participant_replaced_by_bot',
  'participant_restored',
  'room_audit_sealed',
  'room_completed',
  'room_created',
  'room_error',
  'room_version_quarantined',
  'room_voided',
  'student_action',
  'student_action_rejected',
  'student_action_timeout',
]);
const TERMINAL_SESSION_STATES = new Set(['completed', 'voided', 'archived']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const AUDIT_PRIVATE_KEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const AUDIT_SIGNATURE_DOMAIN = 'agentic-trading-games:audit-root-signature:v1';
const TRUSTED_LEGACY_MIGRATION = Symbol('trusted legacy database encryption migration');
const INTERNAL_INTEGRITY_REBUILD = Symbol('internal database integrity rebuild');
const ENCRYPTION_CONTEXT_FIELDS = Object.freeze({
  sessions: [['id', 'text'], ['game', 'text'], ['mode', 'text']],
  participants: [
    ['id', 'text'], ['session_id', 'text'], ['roster_identity_hash', 'text'], ['token_hash', 'text'],
  ],
  rooms: [
    ['id', 'text'], ['session_id', 'text'], ['seed_commitment', 'text'], ['game', 'text'], ['mode', 'text'],
    ['sequence', 'nonnegative-integer'], ['rng_counter', 'nonnegative-integer'],
  ],
  events: [['id', 'integer'], ['session_id', 'text'], ['event_hash', 'text']],
  decisions: [
    ['id', 'integer'], ['session_id', 'text'], ['room_id', 'text'], ['player_id', 'text'],
    ['game', 'text'], ['created_at', 'text'],
  ],
  annotations: [
    ['id', 'integer'], ['session_id', 'text'], ['room_id', 'nullable-text'], ['player_id', 'nullable-text'],
    ['kind', 'text'], ['created_at', 'text'],
  ],
  app_settings: [['key', 'text']],
  roster_entries: [
    ['id', 'text'], ['session_id', 'text'], ['identity_hash', 'text'], ['invite_hash', 'text'],
  ],
  controller_events: [
    ['id', 'integer'], ['session_id', 'text'], ['room_id', 'nullable-text'], ['player_id', 'text'],
    ['controller', 'text'], ['actor_id', 'text'], ['sequence', 'nullable-nonnegative-integer'], ['occurred_at', 'text'],
  ],
  result_provenance: [
    ['id', 'integer'], ['session_id', 'text'], ['room_id', 'text'], ['player_id', 'text'],
    ['controller_summary', 'text'], ['competitive_eligible', 'boolean-integer'],
    ['transcript_root', 'nullable-text'], ['created_at', 'text'],
  ],
});
const INTEGER_ID_TABLES = new Set(['events', 'decisions', 'annotations', 'controller_events', 'result_provenance']);
const MUTABLE_ENCRYPTION_CONTEXT_FIELDS = new Set([
  'rooms.sequence', 'rooms.rng_counter', 'roster_entries.invite_hash',
]);
const ENCRYPTED_FIELD_TARGETS = Object.freeze([
  ['sessions', 'id', ['config_json']],
  ['participants', 'id', ['name', 'roster_identity']],
  ['rooms', 'id', ['seed_hex', 'players_json', 'state_json']],
  ['events', 'id', ['payload_json']],
  ['decisions', 'id', ['context_json', 'legal_json', 'action_json', 'benchmark_json', 'outcome_json']],
  ['annotations', 'id', ['note']],
  ['app_settings', 'key', ['value']],
  ['roster_entries', 'id', ['identity_key', 'display_name']],
  ['controller_events', 'id', ['reason']],
  ['result_provenance', 'id', ['result_json']],
]);
const INTEGRITY_TABLES = Object.freeze([
  { table: 'sessions', keys: ['id'], columns: ['id', 'join_code', 'state', 'game', 'mode', 'config_json', 'created_at', 'updated_at', 'completed_at'] },
  { table: 'participants', keys: ['id'], columns: ['id', 'session_id', 'name', 'token_hash', 'roster_identity', 'roster_identity_hash', 'room_id', 'is_connected', 'competitive_eligible', 'controller_provenance', 'auth_expires_at', 'auth_revoked_at', 'removed_at', 'created_at'] },
  { table: 'rooms', keys: ['id'], columns: ['id', 'session_id', 'ordinal', 'game', 'mode', 'status', 'sequence', 'seed_commitment', 'seed_hex', 'rng_counter', 'players_json', 'state_json', 'transcript_root', 'updated_at'] },
  { table: 'events', keys: ['id'], columns: ['id', 'session_id', 'room_id', 'sequence', 'actor_id', 'type', 'visibility', 'payload_json', 'previous_hash', 'event_hash', 'created_at'] },
  { table: 'decisions', keys: ['id'], columns: ['id', 'session_id', 'room_id', 'player_id', 'game', 'context_json', 'legal_json', 'action_json', 'benchmark_json', 'outcome_json', 'created_at'] },
  { table: 'accepted_actions', keys: ['room_id', 'action_id'], columns: ['room_id', 'action_id', 'player_id', 'created_at'] },
  { table: 'annotations', keys: ['id'], columns: ['id', 'session_id', 'room_id', 'player_id', 'kind', 'note', 'created_at'] },
  { table: 'app_settings', keys: ['key'], columns: ['key', 'value'] },
  { table: 'roster_entries', keys: ['id'], columns: ['id', 'session_id', 'identity_key', 'identity_hash', 'display_name', 'invite_hash', 'redeemed_at', 'participant_id', 'revoked_at', 'created_at'] },
  { table: 'controller_events', keys: ['id'], columns: ['id', 'session_id', 'room_id', 'player_id', 'controller', 'reason', 'actor_id', 'sequence', 'occurred_at'] },
  { table: 'result_provenance', keys: ['id'], columns: ['id', 'session_id', 'room_id', 'player_id', 'controller_summary', 'competitive_eligible', 'result_json', 'transcript_root', 'created_at'] },
  { table: 'web_sessions', keys: ['session_hash'], columns: ['session_hash', 'participant_id', 'csrf_hash', 'expires_at', 'revoked_at', 'created_at', 'binding_hash'] },
]);
const INTEGRITY_TABLE_BY_NAME = new Map(INTEGRITY_TABLES.map((entry) => [entry.table, entry]));
const EMPTY_INTEGRITY_XOR = '0'.repeat(64);
const APPLICATION_SCHEMA_TABLES = new Set([
  ...INTEGRITY_TABLES.map(({ table }) => table),
  'row_integrity',
  'integrity_manifest',
  'sqlite_sequence',
]);
const APPLICATION_SCHEMA_INDEXES = new Map([
  ['idx_events_session', 'events'],
  ['idx_events_room', 'events'],
  ['idx_decisions_player', 'decisions'],
  ['idx_accepted_actions_player', 'accepted_actions'],
  ['idx_controller_events_player', 'controller_events'],
  ['idx_result_provenance_session', 'result_provenance'],
  ['idx_web_sessions_participant', 'web_sessions'],
  ['idx_participants_active_roster_identity', 'participants'],
  ['idx_roster_session_identity', 'roster_entries'],
  ['idx_roster_session', 'roster_entries'],
  ['idx_participants_auth', 'participants'],
  ['idx_events_session_hash', 'events'],
  ['idx_rooms_session_ordinal', 'rooms'],
]);
const APPLICATION_SCHEMA_TRIGGERS = new Map([
  ['participants_require_roster_identity_insert', 'participants'],
  ['participants_require_roster_identity_update', 'participants'],
  ['web_sessions_require_binding_insert', 'web_sessions'],
  ['protect_web_sessions_binding', 'web_sessions'],
  ...Object.keys(ENCRYPTION_CONTEXT_FIELDS).map((table) =>
    [`protect_${table}_encryption_context`, table]),
  ...INTEGRITY_TABLES.flatMap(({ table }) => ['insert', 'update', 'delete'].map((operation) =>
    [`agentic_integrity_${table}_${operation}`, table])),
]);

function auditPrivateKeyFromDataKey(value) {
  const dataKey = normalizeEncryptionKey(value);
  const seed = Buffer.from(crypto.hkdfSync('sha256', dataKey,
    Buffer.from('agentic-trading-games:audit-signing-salt:v1'),
    Buffer.from('ed25519-terminal-audit-root'), 32));
  return crypto.createPrivateKey({
    key: Buffer.concat([AUDIT_PRIVATE_KEY_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function auditPublicKeyFromDataKey(value, { format = 'pem' } = {}) {
  const publicKey = crypto.createPublicKey(auditPrivateKeyFromDataKey(value));
  if (format === 'der') return publicKey.export({ format: 'der', type: 'spki' });
  if (format !== 'pem') throw new Error('Audit public-key format must be pem or der');
  return publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

function auditSignatureMessage(sessionId, root) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Audit session id is required');
  if (!HASH_PATTERN.test(String(root))) throw new Error('Audit root must be a SHA-256 hash');
  return Buffer.from(`${AUDIT_SIGNATURE_DOMAIN}\0${sessionId}\0${root}`, 'utf8');
}

export function protectedAppDataDirectory({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local');
    return path.join(localAppData, APP_DATA_DIRECTORY);
  }
  if (platform === 'darwin') return path.join(homeDirectory, 'Library', 'Application Support', APP_DATA_DIRECTORY);
  const dataHome = environment.XDG_DATA_HOME || path.join(homeDirectory, '.local', 'share');
  return path.join(dataHome, 'agentic-trading-games');
}

export function defaultDatabasePath(options = {}) {
  return path.join(protectedAppDataDirectory(options), DATABASE_FILENAME);
}

export function migrateLegacyDatabaseEncryption(filename, {
  encryptionKey = process.env.AGENTIC_DATA_KEY,
} = {}) {
  if (typeof filename !== 'string' || !filename || filename === ':memory:' || filename.startsWith('file::memory:')) {
    throw new Error('An on-disk database path is required for trusted offline migration');
  }
  let database;
  try {
    database = new Database(filename, {
      encryptionKey,
      [TRUSTED_LEGACY_MIGRATION]: TRUSTED_LEGACY_MIGRATION,
    });
    return { migrated: database.legacyEncryptionMigrated, envelopeVersion: 2 };
  } finally {
    database?.close();
  }
}

export class Database {
  constructor(filename = defaultDatabasePath(), options = {}) {
    const encryptionKey = options.encryptionKey ?? process.env.AGENTIC_DATA_KEY;
    const migrationAuthority = options[TRUSTED_LEGACY_MIGRATION] === TRUSTED_LEGACY_MIGRATION
      ? TRUSTED_LEGACY_MIGRATION
      : null;
    this.filename = filename;
    const keyMaterial = encryptionKey ?? process.env.AGENTIC_DATA_KEY;
    this.cipher = new FieldCipher(keyMaterial);
    this.auditPrivateKey = auditPrivateKeyFromDataKey(keyMaterial);
    this.auditPublicKeyObject = crypto.createPublicKey(this.auditPrivateKey);
    this.inTransaction = false;
    this.ephemeral = filename === ':memory:' || filename.startsWith('file::memory:');
    if (!this.ephemeral) protectDataDirectory(path.dirname(path.resolve(filename)));

    this.db = new DatabaseSync(filename);
    try {
      const sqliteVersion = this.db.prepare('SELECT sqlite_version() AS version').get().version;
      if (compareVersions(sqliteVersion, '3.51.3') < 0) {
        throw new Error(`SQLite ${sqliteVersion} is too old; 3.51.3 or newer is required`);
      }
      const schemaPreflight = this.preflightDatabaseSchema(migrationAuthority);
      this.authenticatedSchemaDigest = schemaPreflight.schemaDigest ?? null;
      this.registerIntegrityFunctions();
      if (schemaPreflight.integrityPresent) this.verifyDatabaseIntegrity();
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          join_code TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          game TEXT NOT NULL,
          mode TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          roster_identity TEXT NOT NULL,
          roster_identity_hash TEXT NOT NULL,
          room_id TEXT,
          is_connected INTEGER NOT NULL DEFAULT 0,
          competitive_eligible INTEGER NOT NULL DEFAULT 0 CHECK (competitive_eligible IN (0, 1)),
          controller_provenance TEXT NOT NULL DEFAULT 'human'
            CHECK (controller_provenance IN ('human', 'bot', 'mixed')),
          auth_expires_at TEXT,
          auth_revoked_at TEXT,
          removed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          ordinal INTEGER,
          game TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          seed_commitment TEXT NOT NULL,
          seed_hex TEXT,
          rng_counter INTEGER NOT NULL DEFAULT 0,
          players_json TEXT NOT NULL,
          state_json TEXT NOT NULL,
          transcript_root TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          room_id TEXT,
          sequence INTEGER,
          actor_id TEXT,
          type TEXT NOT NULL,
          visibility TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          event_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
        CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, sequence);
        CREATE TABLE IF NOT EXISTS decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          game TEXT NOT NULL,
          context_json TEXT NOT NULL,
          legal_json TEXT NOT NULL,
          action_json TEXT NOT NULL,
          benchmark_json TEXT NOT NULL,
          outcome_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_player ON decisions(session_id, player_id, id);
        CREATE TABLE IF NOT EXISTS accepted_actions (
          room_id TEXT NOT NULL REFERENCES rooms(id),
          action_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (room_id, action_id)
        );
        CREATE INDEX IF NOT EXISTS idx_accepted_actions_player ON accepted_actions(player_id);
        CREATE TABLE IF NOT EXISTS annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          room_id TEXT,
          player_id TEXT,
          kind TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const integrityPresent = schemaPreflight.integrityPresent;
      const existingSemanticRows = this.semanticRowCount();
      if (!integrityPresent && existingSemanticRows > 0 && migrationAuthority !== TRUSTED_LEGACY_MIGRATION) {
        throw new Error('Authenticated database manifest is missing for a nonempty database; normal startup refuses import. ' +
          'Verified legacy databases require scripts/migrate-database-encryption.mjs --trusted-offline-source');
      }
      this.ensureIntegritySchema();
      const legacyGeneration = migrationAuthority === TRUSTED_LEGACY_MIGRATION
        ? this.classifyLegacyEncryptionGeneration(migrationAuthority)
        : null;
      const encryptedLegacyData = this.migrateSchema(migrationAuthority, legacyGeneration);
      this.legacyEncryptionMigrated = encryptedLegacyData;
      this.ensureEncryptionKeyCheck();
      this.verifyStoredEventChains();
      if (integrityPresent) {
        this.verifyDatabaseIntegrity();
      } else {
        this.rebuildDatabaseIntegrity(INTERNAL_INTEGRITY_REBUILD);
      }
      this.prepareStatements();
      if (encryptedLegacyData) this.compactSensitiveData();
      if (!this.ephemeral) protectDatabaseFile(filename);
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  databaseSchemaRows() {
    return this.db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type, name`).all().map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql == null ? null : String(row.sql),
    }));
  }

  databaseSchemaDigest(rows = this.databaseSchemaRows()) {
    return crypto.createHash('sha256').update(canonicalJson(rows)).digest('hex');
  }

  assertAllowedSchemaObjects(rows) {
    for (const row of rows) {
      if (row.type === 'table') {
        if (!APPLICATION_SCHEMA_TABLES.has(row.name) || row.table !== row.name || typeof row.sql !== 'string') {
          throw new Error(`Database schema contains unexpected table ${row.name}`);
        }
        continue;
      }
      if (row.type === 'index') {
        const expectedTable = APPLICATION_SCHEMA_INDEXES.get(row.name);
        const autoIndex = row.sql == null && APPLICATION_SCHEMA_TABLES.has(row.table) &&
          row.name.startsWith(`sqlite_autoindex_${row.table}_`) &&
          /^\d+$/.test(row.name.slice(`sqlite_autoindex_${row.table}_`.length));
        if ((!expectedTable || expectedTable !== row.table || typeof row.sql !== 'string') && !autoIndex) {
          throw new Error(`Database schema contains unexpected index ${row.name}`);
        }
        continue;
      }
      if (row.type === 'trigger') {
        const expectedTable = APPLICATION_SCHEMA_TRIGGERS.get(row.name);
        if (!expectedTable || expectedTable !== row.table || typeof row.sql !== 'string') {
          throw new Error(`Database schema contains unexpected trigger ${row.name}`);
        }
        continue;
      }
      throw new Error(`Database schema contains unsupported ${row.type} ${row.name}`);
    }
  }

  dropTrustedLegacyTriggers(rows) {
    const triggers = rows.filter(({ type }) => type === 'trigger');
    if (!triggers.length) return;
    this.transaction(() => {
      for (const { name } of triggers) this.db.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
    });
  }

  preflightDatabaseSchema(migrationAuthority) {
    const rows = this.databaseSchemaRows();
    if (!rows.length) return { integrityPresent: false };
    this.assertAllowedSchemaObjects(rows);

    const hasRowsTable = rows.some(({ type, name }) => type === 'table' && name === 'row_integrity');
    const hasManifestTable = rows.some(({ type, name }) => type === 'table' && name === 'integrity_manifest');
    if (hasRowsTable !== hasManifestTable) {
      throw new Error('Database integrity schema is incomplete');
    }
    if (hasManifestTable) {
      const manifestColumns = tableColumns(this.db, 'integrity_manifest');
      if (!manifestColumns.has('schema_digest')) {
        throw new Error('Database schema manifest predates authenticated schema enforcement');
      }
      const manifests = this.db.prepare('SELECT * FROM integrity_manifest').all();
      if (manifests.length !== 1 || Number(manifests[0].id) !== 1) {
        throw new Error('Authenticated database integrity manifest is missing');
      }
      const manifest = manifests[0];
      const schemaDigest = this.databaseSchemaDigest(rows);
      const expectedTag = this.integrityManifestTag(
        Number(manifest.row_count), String(manifest.xor_hex), schemaDigest,
      );
      if (manifest.schema_digest !== schemaDigest || !safeEqualText(String(manifest.tag), expectedTag)) {
        throw new Error('Database schema manifest could not be authenticated');
      }
      return { integrityPresent: true, schemaDigest };
    }

    if (migrationAuthority !== TRUSTED_LEGACY_MIGRATION) {
      throw new Error('Authenticated database manifest is missing; normal startup refuses import. ' +
        'Verified legacy databases require scripts/migrate-database-encryption.mjs --trusted-offline-source');
    }
    this.dropTrustedLegacyTriggers(rows);
    return { integrityPresent: false };
  }

  registerIntegrityFunctions() {
    const options = { deterministic: true, varargs: true };
    this.db.function('agentic_integrity_row_key', options, (table, ...values) => {
      const spec = this.integritySpec(table);
      if (values.length !== spec.keys.length) throw new Error(`Invalid integrity key for ${table}`);
      return this.integrityRowKeyFromValues(spec, values);
    });
    this.db.function('agentic_integrity_row_tag', options, (table, ...values) => {
      const spec = this.integritySpec(table);
      if (values.length !== spec.columns.length) throw new Error(`Invalid integrity row for ${table}`);
      return this.integrityRowTagFromValues(spec, values);
    });
    this.db.function('agentic_integrity_contribution', { deterministic: true },
      (table, rowKey, rowTag) => this.integrityContribution(String(table), String(rowKey), String(rowTag)));
    this.db.function('agentic_integrity_xor', { deterministic: true },
      (left, right) => xorIntegrityHex(String(left), String(right)));
    this.db.function('agentic_integrity_manifest_tag', { deterministic: true },
      (rowCount, xorHex, schemaDigest) => this.integrityManifestTag(
        Number(rowCount), String(xorHex), String(schemaDigest),
      ));
  }

  ensureIntegritySchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS row_integrity (
        table_name TEXT NOT NULL,
        row_key TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (table_name, row_key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS integrity_manifest (
        id INTEGER PRIMARY KEY CHECK (id=1),
        row_count INTEGER NOT NULL CHECK (row_count>=0),
        xor_hex TEXT NOT NULL,
        schema_digest TEXT NOT NULL,
        tag TEXT NOT NULL
      );
    `);
  }

  databaseIntegrityPresent() {
    const tables = this.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('row_integrity','integrity_manifest')`).all();
    if (tables.length !== 2) return false;
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM integrity_manifest').get().count) === 1;
  }

  semanticRowCount() {
    let count = 0;
    for (const spec of INTEGRITY_TABLES) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
      count += Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(spec.table)}`).get().count);
    }
    return count;
  }

  integritySpec(table) {
    const spec = INTEGRITY_TABLE_BY_NAME.get(String(table));
    if (!spec) throw new Error(`Table ${table} is not covered by database integrity`);
    return spec;
  }

  assertIntegrityTableColumns(spec) {
    const columns = tableColumns(this.db, spec.table);
    const missing = spec.columns.filter((column) => !columns.has(column));
    const unexpected = [...columns].filter((column) => !spec.columns.includes(column));
    if (missing.length || unexpected.length) {
      throw new Error(`Integrity schema columns for ${spec.table} do not match the authenticated model`);
    }
  }

  integrityRowKeyFromValues(spec, values) {
    return canonicalJson(values.map(normalizeIntegrityValue));
  }

  integrityRowKey(spec, row) {
    return this.integrityRowKeyFromValues(spec, spec.keys.map((column) => row[column]));
  }

  integrityRowTagFromValues(spec, values) {
    const columns = spec.columns.map((column, index) => [column, normalizeIntegrityValue(values[index])]);
    return this.cipher.index('database-row-integrity-v1', canonicalJson({ table: spec.table, columns }));
  }

  integrityRowTag(spec, row) {
    return this.integrityRowTagFromValues(spec, spec.columns.map((column) => row[column]));
  }

  integrityContribution(table, rowKey, rowTag) {
    if (!HASH_PATTERN.test(rowTag)) throw new Error('Database row-integrity tag is invalid');
    return this.cipher.index('database-set-contribution-v1', canonicalJson({ table, rowKey, rowTag }));
  }

  integrityManifestTag(rowCount, xorHex, schemaDigest) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || !HASH_PATTERN.test(xorHex) ||
        !HASH_PATTERN.test(schemaDigest)) {
      throw new Error('Database integrity manifest is invalid');
    }
    return this.cipher.index('database-set-manifest-v2', canonicalJson({ rowCount, xorHex, schemaDigest }));
  }

  dropIntegrityTriggers() {
    for (const spec of INTEGRITY_TABLES) {
      for (const operation of ['insert', 'update', 'delete']) {
        this.db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`agentic_integrity_${spec.table}_${operation}`)}`);
      }
    }
  }

  createIntegrityTriggers() {
    this.dropIntegrityTriggers();
    for (const spec of INTEGRITY_TABLES) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
      this.assertIntegrityTableColumns(spec);
      const sqlTable = quoteIdentifier(spec.table);
      const literalTable = `'${spec.table}'`;
      const key = (prefix) => `agentic_integrity_row_key(${literalTable}, ${spec.keys
        .map((column) => `${prefix}.${quoteIdentifier(column)}`).join(', ')})`;
      const tag = (prefix) => `agentic_integrity_row_tag(${literalTable}, ${spec.columns
        .map((column) => `${prefix}.${quoteIdentifier(column)}`).join(', ')})`;
      const contribution = (prefix) =>
        `agentic_integrity_contribution(${literalTable}, ${key(prefix)}, ${tag(prefix)})`;
      const manifestCheck = `SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM integrity_manifest WHERE id=1
          AND tag=agentic_integrity_manifest_tag(row_count, xor_hex, schema_digest)
      ) THEN RAISE(ABORT, 'database integrity manifest is unavailable') END;`;
      const oldRowCheck = `SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM row_integrity WHERE table_name=${literalTable}
          AND row_key=${key('OLD')} AND tag=${tag('OLD')}
      ) THEN RAISE(ABORT, 'stored row integrity could not be authenticated') END;`;
      const insertXor = `agentic_integrity_xor(xor_hex, ${contribution('NEW')})`;
      const updateXor = `agentic_integrity_xor(agentic_integrity_xor(xor_hex, ${contribution('OLD')}), ${contribution('NEW')})`;
      const deleteXor = `agentic_integrity_xor(xor_hex, ${contribution('OLD')})`;
      this.db.exec(`
        CREATE TRIGGER ${quoteIdentifier(`agentic_integrity_${spec.table}_insert`)}
        AFTER INSERT ON ${sqlTable}
        BEGIN
          ${manifestCheck}
          INSERT INTO row_integrity (table_name, row_key, tag)
            VALUES (${literalTable}, ${key('NEW')}, ${tag('NEW')});
          UPDATE integrity_manifest SET
            tag=agentic_integrity_manifest_tag(row_count+1, ${insertXor}, schema_digest),
            xor_hex=${insertXor}, row_count=row_count+1 WHERE id=1;
        END;
        CREATE TRIGGER ${quoteIdentifier(`agentic_integrity_${spec.table}_update`)}
        AFTER UPDATE ON ${sqlTable}
        BEGIN
          ${manifestCheck}
          ${oldRowCheck}
          DELETE FROM row_integrity WHERE table_name=${literalTable} AND row_key=${key('OLD')};
          INSERT INTO row_integrity (table_name, row_key, tag)
            VALUES (${literalTable}, ${key('NEW')}, ${tag('NEW')});
          UPDATE integrity_manifest SET
            tag=agentic_integrity_manifest_tag(row_count, ${updateXor}, schema_digest),
            xor_hex=${updateXor} WHERE id=1;
        END;
        CREATE TRIGGER ${quoteIdentifier(`agentic_integrity_${spec.table}_delete`)}
        AFTER DELETE ON ${sqlTable}
        BEGIN
          ${manifestCheck}
          ${oldRowCheck}
          DELETE FROM row_integrity WHERE table_name=${literalTable} AND row_key=${key('OLD')};
          UPDATE integrity_manifest SET
            tag=agentic_integrity_manifest_tag(row_count-1, ${deleteXor}, schema_digest),
            xor_hex=${deleteXor}, row_count=row_count-1 WHERE id=1;
        END;
      `);
    }
  }

  rebuildDatabaseIntegrity(authority) {
    if (authority !== INTERNAL_INTEGRITY_REBUILD) throw new Error('Database integrity rebuild is not a runtime operation');
    this.transaction(() => {
      this.dropIntegrityTriggers();
      this.db.exec('DELETE FROM row_integrity; DELETE FROM integrity_manifest;');
      let rowCount = 0;
      let xorHex = EMPTY_INTEGRITY_XOR;
      const insert = this.db.prepare(
        'INSERT INTO row_integrity (table_name, row_key, tag) VALUES (?, ?, ?)',
      );
      for (const spec of INTEGRITY_TABLES) {
        if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
        this.assertIntegrityTableColumns(spec);
        for (const row of this.db.prepare(`SELECT * FROM ${quoteIdentifier(spec.table)}`).all()) {
          const rowKey = this.integrityRowKey(spec, row);
          const rowTag = this.integrityRowTag(spec, row);
          insert.run(spec.table, rowKey, rowTag);
          xorHex = xorIntegrityHex(xorHex, this.integrityContribution(spec.table, rowKey, rowTag));
          rowCount += 1;
        }
      }
      this.createIntegrityTriggers();
      const schemaDigest = this.databaseSchemaDigest();
      this.db.prepare(`INSERT INTO integrity_manifest (id, row_count, xor_hex, schema_digest, tag)
        VALUES (1, ?, ?, ?, ?)`).run(
        rowCount, xorHex, schemaDigest, this.integrityManifestTag(rowCount, xorHex, schemaDigest),
      );
    });
    return this.verifyDatabaseIntegrity();
  }

  verifyDatabaseIntegrity() {
    if (!this.databaseIntegrityPresent()) throw new Error('Authenticated database integrity manifest is missing');
    const storedEntries = new Map(this.db.prepare('SELECT * FROM row_integrity').all().map((row) => [
      `${row.table_name}\0${row.row_key}`, row.tag,
    ]));
    let rowCount = 0;
    let xorHex = EMPTY_INTEGRITY_XOR;
    for (const spec of INTEGRITY_TABLES) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
      this.assertIntegrityTableColumns(spec);
      for (const row of this.db.prepare(`SELECT * FROM ${quoteIdentifier(spec.table)}`).all()) {
        const rowKey = this.integrityRowKey(spec, row);
        const rowTag = this.integrityRowTag(spec, row);
        const mapKey = `${spec.table}\0${rowKey}`;
        const storedTag = storedEntries.get(mapKey);
        if (typeof storedTag !== 'string' || !safeEqualText(storedTag, rowTag)) {
          throw new Error(`Stored ${spec.table} row integrity could not be authenticated`);
        }
        storedEntries.delete(mapKey);
        xorHex = xorIntegrityHex(xorHex, this.integrityContribution(spec.table, rowKey, rowTag));
        rowCount += 1;
      }
    }
    if (storedEntries.size) throw new Error('Database integrity contains orphaned row records');
    const manifest = this.db.prepare('SELECT * FROM integrity_manifest WHERE id=1').get();
    const schemaDigest = this.databaseSchemaDigest();
    const expectedTag = this.integrityManifestTag(rowCount, xorHex, schemaDigest);
    if (Number(manifest.row_count) !== rowCount || manifest.xor_hex !== xorHex ||
        manifest.schema_digest !== schemaDigest ||
        !safeEqualText(manifest.tag, expectedTag)) {
      throw new Error('Authenticated database set manifest does not match the stored rows');
    }
    this.authenticatedSchemaDigest = schemaDigest;
    return { rowCount, xorHex, schemaDigest };
  }

  verifyRowIntegrity(table, row) {
    if (!row) return row;
    const spec = this.integritySpec(table);
    const manifest = this.db.prepare('SELECT * FROM integrity_manifest WHERE id=1').get();
    const schemaDigest = this.authenticatedSchemaDigest;
    if (!manifest || !safeEqualText(manifest.tag,
      this.integrityManifestTag(Number(manifest.row_count), String(manifest.xor_hex), schemaDigest)) ||
        manifest.schema_digest !== schemaDigest) {
      throw new Error('Authenticated database integrity manifest could not be verified');
    }
    const rowKey = this.integrityRowKey(spec, row);
    const expected = this.integrityRowTag(spec, row);
    const stored = this.db.prepare(
      'SELECT tag FROM row_integrity WHERE table_name=? AND row_key=?',
    ).get(spec.table, rowKey);
    if (!stored || !safeEqualText(stored.tag, expected)) {
      throw new Error(`Stored ${spec.table} row integrity could not be authenticated`);
    }
    return row;
  }

  migrateSchema(migrationAuthority = null, legacyGeneration = null) {
    const roomColumns = tableColumns(this.db, 'rooms');
    if (!roomColumns.has('ordinal')) this.db.exec('ALTER TABLE rooms ADD COLUMN ordinal INTEGER');
    if (!roomColumns.has('transcript_root')) this.db.exec('ALTER TABLE rooms ADD COLUMN transcript_root TEXT');

    const participantColumns = tableColumns(this.db, 'participants');
    if (!participantColumns.has('roster_identity')) this.db.exec('ALTER TABLE participants ADD COLUMN roster_identity TEXT');
    if (!participantColumns.has('roster_identity_hash')) this.db.exec('ALTER TABLE participants ADD COLUMN roster_identity_hash TEXT');
    if (!participantColumns.has('competitive_eligible')) {
      this.db.exec('ALTER TABLE participants ADD COLUMN competitive_eligible INTEGER NOT NULL DEFAULT 0 CHECK (competitive_eligible IN (0, 1))');
    }
    if (!participantColumns.has('controller_provenance')) {
      this.db.exec("ALTER TABLE participants ADD COLUMN controller_provenance TEXT NOT NULL DEFAULT 'human' CHECK (controller_provenance IN ('human', 'bot', 'mixed'))");
    }
    if (!participantColumns.has('auth_expires_at')) this.db.exec('ALTER TABLE participants ADD COLUMN auth_expires_at TEXT');
    if (!participantColumns.has('auth_revoked_at')) this.db.exec('ALTER TABLE participants ADD COLUMN auth_revoked_at TEXT');

    const eventColumns = tableColumns(this.db, 'events');
    const needsEventBackfill = !eventColumns.has('previous_hash') || !eventColumns.has('event_hash');
    if (!eventColumns.has('previous_hash')) this.db.exec('ALTER TABLE events ADD COLUMN previous_hash TEXT');
    if (!eventColumns.has('event_hash')) this.db.exec('ALTER TABLE events ADD COLUMN event_hash TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roster_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL,
        identity_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        invite_hash TEXT NOT NULL UNIQUE,
        redeemed_at TEXT,
        participant_id TEXT UNIQUE REFERENCES participants(id) ON DELETE SET NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, identity_key)
      );
      CREATE TABLE IF NOT EXISTS controller_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        room_id TEXT,
        player_id TEXT NOT NULL,
        controller TEXT NOT NULL CHECK (controller IN ('human', 'bot', 'system')),
        reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        sequence INTEGER,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS result_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL,
        controller_summary TEXT NOT NULL CHECK (controller_summary IN ('human', 'bot', 'mixed')),
        competitive_eligible INTEGER NOT NULL CHECK (competitive_eligible IN (0, 1)),
        result_json TEXT NOT NULL,
        transcript_root TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(room_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        session_hash TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        binding_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_controller_events_player
        ON controller_events(session_id, player_id, id);
      CREATE INDEX IF NOT EXISTS idx_result_provenance_session
        ON result_provenance(session_id, room_id, player_id);
      CREATE INDEX IF NOT EXISTS idx_web_sessions_participant
        ON web_sessions(participant_id, expires_at, revoked_at);
    `);

    const webSessionColumns = tableColumns(this.db, 'web_sessions');
    if (!webSessionColumns.has('binding_hash')) {
      this.db.exec('ALTER TABLE web_sessions ADD COLUMN binding_hash TEXT');
    }
    const unboundWebSessions = this.db.prepare(
      'SELECT * FROM web_sessions WHERE binding_hash IS NULL',
    ).all();
    if (unboundWebSessions.length) requireLegacyMigrationAuthority(migrationAuthority);
    if (unboundWebSessions.length) {
      const bindWebSession = this.db.prepare(
        'UPDATE web_sessions SET binding_hash=? WHERE session_hash=? AND binding_hash IS NULL',
      );
      this.transaction(() => {
        for (const row of unboundWebSessions) {
          bindWebSession.run(this.webSessionBinding(row), row.session_hash);
        }
      });
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS web_sessions_require_binding_insert
      BEFORE INSERT ON web_sessions WHEN NEW.binding_hash IS NULL
      BEGIN SELECT RAISE(ABORT, 'web-session binding is required'); END;
      DROP TRIGGER IF EXISTS protect_web_sessions_binding;
      CREATE TRIGGER protect_web_sessions_binding
      BEFORE UPDATE OF session_hash, participant_id, csrf_hash, expires_at, created_at, binding_hash ON web_sessions
      WHEN NEW.session_hash IS NOT OLD.session_hash OR NEW.participant_id IS NOT OLD.participant_id
        OR NEW.csrf_hash IS NOT OLD.csrf_hash OR NEW.expires_at IS NOT OLD.expires_at
        OR NEW.created_at IS NOT OLD.created_at OR NEW.binding_hash IS NOT OLD.binding_hash
      BEGIN SELECT RAISE(ABORT, 'web-session binding is immutable'); END;
    `);

    const sessions = this.db.prepare('SELECT DISTINCT session_id FROM rooms WHERE ordinal IS NULL').all();
    if (sessions.length) {
      const orderedRooms = this.db.prepare(`
        SELECT rooms.id
        FROM rooms
        LEFT JOIN events ON events.session_id=rooms.session_id
          AND events.room_id=rooms.id AND events.type='room_created'
        WHERE rooms.session_id=?
        GROUP BY rooms.id
        ORDER BY MIN(events.id) IS NULL, MIN(events.id), rooms.id
      `);
      const updateOrdinal = this.db.prepare('UPDATE rooms SET ordinal=? WHERE id=?');
      this.transaction(() => {
        for (const { session_id: sessionId } of sessions) {
          orderedRooms.all(sessionId).forEach((room, ordinal) => updateOrdinal.run(ordinal, room.id));
        }
      });
    }

    const incompleteParticipants = this.db.prepare(
      'SELECT * FROM participants WHERE roster_identity IS NULL OR roster_identity_hash IS NULL',
    ).all();
    const incompleteRoster = this.db.prepare(
      'SELECT * FROM roster_entries WHERE identity_hash IS NULL',
    ).all();
    if (incompleteParticipants.length || incompleteRoster.length) {
      requireLegacyMigrationAuthority(migrationAuthority);
    }
    this.transaction(() => {
      const updateParticipant = this.db.prepare(
        'UPDATE participants SET roster_identity=?, roster_identity_hash=? WHERE id=?',
      );
      for (const participant of incompleteParticipants) {
        let identity = `legacy:${participant.id}`;
        if (participant.roster_identity) {
          const version = this.cipher.envelopeVersion(participant.roster_identity);
          if (version === 2) throw new Error('Encrypted participant identity is missing its row context');
          identity = version === 1
            ? this.cipher.decrypt('participants', 'roster_identity', participant.roster_identity, null)
            : String(participant.roster_identity);
        }
        updateParticipant.run(identity, this.identityHash('participant', identity), participant.id);
      }
      const updateRoster = this.db.prepare('UPDATE roster_entries SET identity_hash=? WHERE id=?');
      for (const entry of incompleteRoster) {
        const version = this.cipher.envelopeVersion(entry.identity_key);
        if (version === 2) throw new Error('Encrypted roster identity is missing its row context');
        const identity = version === 1
          ? this.cipher.decrypt('roster_entries', 'identity_key', entry.identity_key, null)
          : String(entry.identity_key);
        updateRoster.run(this.identityHash('roster', identity), entry.id);
      }
    });

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_active_roster_identity
        ON participants(session_id, roster_identity_hash) WHERE removed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_session_identity
        ON roster_entries(session_id, identity_hash);
      CREATE INDEX IF NOT EXISTS idx_roster_session ON roster_entries(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_participants_auth ON participants(token_hash, auth_expires_at, auth_revoked_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_hash ON events(session_id, event_hash);
      CREATE TRIGGER IF NOT EXISTS participants_require_roster_identity_insert
      BEFORE INSERT ON participants
      WHEN NEW.roster_identity IS NULL OR NEW.roster_identity_hash IS NULL
      BEGIN SELECT RAISE(ABORT, 'participant roster identity is required'); END;
      CREATE TRIGGER IF NOT EXISTS participants_require_roster_identity_update
      BEFORE UPDATE OF roster_identity, roster_identity_hash ON participants
      WHEN NEW.roster_identity IS NULL OR NEW.roster_identity_hash IS NULL
      BEGIN SELECT RAISE(ABORT, 'participant roster identity is required'); END;
    `);

    const incompleteEvent = this.db.prepare(
      'SELECT id FROM events WHERE previous_hash IS NULL OR event_hash IS NULL LIMIT 1',
    ).get();
    if (needsEventBackfill || incompleteEvent) {
      requireLegacyMigrationAuthority(migrationAuthority);
      this.backfillEventHashes(migrationAuthority);
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_session_ordinal ON rooms(session_id, ordinal)');
    this.ensureEncryptionContextImmutability();
    if (migrationAuthority === TRUSTED_LEGACY_MIGRATION && legacyGeneration !== 'v2') {
      const changed = this.migrateLegacyEncryption(migrationAuthority);
      this.assertProtectedFieldsUseV2();
      this.assertWebSessionBindings();
      return changed;
    }
    this.assertProtectedFieldsUseV2();
    this.assertWebSessionBindings();
    return false;
  }

  classifyLegacyEncryptionGeneration(migrationAuthority) {
    requireLegacyMigrationAuthority(migrationAuthority);
    const generations = new Set();
    for (const [table, , fields] of ENCRYPTED_FIELD_TARGETS) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const row of this.db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all()) {
        for (const field of fields) {
          const value = row[field];
          if (value == null) continue;
          const version = this.cipher.envelopeVersion(value);
          if (version === 1) generations.add('v1');
          else if (version === 2) generations.add('v2');
          else if (version == null) generations.add('plaintext');
          else throw new Error(`Unsupported encrypted ${table}.${field} envelope version v${version}`);
        }
      }
    }
    if (generations.size > 1) {
      throw new Error(`Refusing to migrate mixed protected-data generations: ${[...generations].sort().join(', ')}`);
    }
    return generations.values().next().value ?? 'empty';
  }

  ensureEncryptionContextImmutability() {
    for (const [table, fields] of Object.entries(ENCRYPTION_CONTEXT_FIELDS)) {
      const trigger = `protect_${table}_encryption_context`;
      const immutableFields = fields.filter(([column]) => !MUTABLE_ENCRYPTION_CONTEXT_FIELDS.has(`${table}.${column}`));
      const columns = immutableFields.map(([column]) => quoteIdentifier(column));
      const changed = immutableFields.map(([column]) =>
        `NEW.${quoteIdentifier(column)} IS NOT OLD.${quoteIdentifier(column)}`).join(' OR ');
      this.db.exec(`
        DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)};
        CREATE TRIGGER ${quoteIdentifier(trigger)}
        BEFORE UPDATE OF ${columns.join(', ')} ON ${quoteIdentifier(table)}
        WHEN ${changed}
        BEGIN SELECT RAISE(ABORT, 'encrypted row context is immutable'); END;
      `);
    }
  }

  backfillEventHashes(migrationAuthority) {
    requireLegacyMigrationAuthority(migrationAuthority);
    const update = this.db.prepare('UPDATE events SET previous_hash=?, event_hash=? WHERE id=?');
    const previousBySession = new Map();
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM events ORDER BY id').all()) {
        const previousHash = previousBySession.get(row.session_id) ?? EVENT_GENESIS_HASH;
        const eventHash = this.calculateEventHash(row, previousHash, { migrationAuthority });
        update.run(previousHash, eventHash, row.id);
        previousBySession.set(row.session_id, eventHash);
      }
    });
  }

  migrateLegacyEncryption(migrationAuthority) {
    requireLegacyMigrationAuthority(migrationAuthority);
    let changed = false;
    this.transaction(() => {
      for (const [table, keyColumn, fields] of ENCRYPTED_FIELD_TARGETS) {
        const rows = this.db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
        for (const row of rows) {
          const context = encryptionContext(table, row);
          const updates = [];
          const values = [];
          for (const field of fields) {
            const value = row[field];
            if (value == null) continue;
            const version = this.cipher.envelopeVersion(value);
            const plaintext = version == null
              ? String(value)
              : this.cipher.decrypt(table, field, value, context);
            this.validateFieldCommitment(table, field, plaintext, row);
            if (version === 2) continue;
            updates.push(`${quoteIdentifier(field)}=?`);
            values.push(this.cipher.encrypt(table, field, plaintext, context));
          }
          if (!updates.length) continue;
          values.push(row[keyColumn]);
          this.db.prepare(
            `UPDATE ${quoteIdentifier(table)} SET ${updates.join(', ')} WHERE ${quoteIdentifier(keyColumn)}=?`,
          ).run(...values);
          changed = true;
        }
      }
      // A v1 event payload swap must not be ratified by migration before the
      // existing audit chain has authenticated the payload-to-row binding.
      this.verifyStoredEventChains();
    });
    return changed;
  }

  assertProtectedFieldsUseV2() {
    for (const [table, , fields] of ENCRYPTED_FIELD_TARGETS) {
      for (const row of this.db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all()) {
        const context = encryptionContext(table, row);
        for (const field of fields) {
          const value = row[field];
          if (value == null) continue;
          requireV2Envelope(this.cipher, table, field, value);
          const plaintext = this.cipher.decrypt(table, field, value, context);
          this.validateFieldCommitment(table, field, plaintext, row);
        }
        if (table === 'rooms') this.validateRoomEventHead(row);
      }
    }
  }

  validateRoomEventHead(row) {
    const head = this.db.prepare(`SELECT sequence FROM events
      WHERE session_id=? AND room_id=? ORDER BY id DESC LIMIT 1`).get(row.session_id, row.id);
    const roomSequence = Number(row.sequence);
    if (!Number.isSafeInteger(roomSequence) || roomSequence < 0 ||
        (head == null ? roomSequence !== 0 : Number(head.sequence) !== roomSequence)) {
      throw new Error(`Stored room ${row.id} sequence does not match its latest audit event`);
    }
  }

  validateFieldCommitment(table, field, plaintext, row) {
    if (table === 'roster_entries' && field === 'identity_key' &&
        this.identityHash('roster', plaintext) !== row.identity_hash) {
      throw new Error('Roster identity ciphertext does not match its immutable identity hash');
    }
    if (table === 'participants' && field === 'roster_identity' &&
        this.identityHash('participant', plaintext) !== row.roster_identity_hash) {
      throw new Error('Participant identity ciphertext does not match its immutable identity hash');
    }
    if (table === 'rooms' && field === 'seed_hex' && plaintext) {
      const seedMatches = /^[a-f0-9]{64}$/i.test(plaintext) &&
        crypto.createHash('sha256').update(Buffer.from(plaintext, 'hex')).digest('hex') === row.seed_commitment;
      if (!seedMatches) throw new Error('Room seed ciphertext does not match its immutable commitment');
    }
  }

  verifyStoredEventChains() {
    for (const { session_id: sessionId } of this.db.prepare('SELECT DISTINCT session_id FROM events').all()) {
      const verification = this.verifyEventChain(sessionId);
      if (!verification.valid) {
        throw new Error(`Event audit chain verification failed for session ${sessionId} at event ${verification.brokenEventId}`);
      }
    }
  }

  ensureEncryptionKeyCheck() {
    const key = '__database_encryption_key_check_v1';
    const expected = 'agentic-trading-games:aes-256-gcm:v1';
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if (!row) {
      this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
        .run(key, this.writeField('app_settings', 'value', expected, { key }));
      return;
    }
    if (this.readField('app_settings', 'value', row.value, { key }) !== expected) {
      throw new Error('Database encryption key check failed');
    }
  }

  prepareStatements() {
    this.statements = {
      insertSession: this.db.prepare(`INSERT INTO sessions
        (id, join_code, state, game, mode, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      updateSession: this.db.prepare(`UPDATE sessions SET state=?, game=?, mode=?, config_json=?, updated_at=?, completed_at=? WHERE id=?`),
      insertParticipant: this.db.prepare(`INSERT INTO participants
        (id, session_id, name, token_hash, roster_identity, roster_identity_hash, room_id, is_connected,
         competitive_eligible, controller_provenance, auth_expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateParticipantRoom: this.db.prepare('UPDATE participants SET room_id=? WHERE id=?'),
      updateParticipantConnection: this.db.prepare('UPDATE participants SET is_connected=? WHERE id=?'),
      removeParticipant: this.db.prepare(
        'UPDATE participants SET removed_at=?, auth_revoked_at=?, is_connected=0, competitive_eligible=0 WHERE id=?',
      ),
      upsertRoom: this.db.prepare(`INSERT INTO rooms
        (id, session_id, ordinal, game, mode, status, sequence, seed_commitment, seed_hex, rng_counter,
         players_json, state_json, transcript_root, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, status=excluded.status,
        sequence=excluded.sequence, seed_hex=excluded.seed_hex, rng_counter=excluded.rng_counter,
        players_json=excluded.players_json, state_json=excluded.state_json,
        transcript_root=excluded.transcript_root, updated_at=excluded.updated_at
        WHERE rooms.session_id=excluded.session_id AND rooms.seed_commitment=excluded.seed_commitment`),
      insertEvent: this.db.prepare(`INSERT INTO events
        (id, session_id, room_id, sequence, actor_id, type, visibility, payload_json, previous_hash, event_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      eventSession: this.db.prepare('SELECT id FROM sessions WHERE id=?'),
      eventRoom: this.db.prepare('SELECT session_id FROM rooms WHERE id=?'),
      insertDecision: this.db.prepare(`INSERT INTO decisions
        (id, session_id, room_id, player_id, game, context_json, legal_json, action_json, benchmark_json, outcome_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertAcceptedAction: this.db.prepare(`INSERT INTO accepted_actions
        (room_id, action_id, player_id, created_at) VALUES (?, ?, ?, ?)`),
      acceptedAction: this.db.prepare('SELECT * FROM accepted_actions WHERE room_id=? AND action_id=?'),
      insertAnnotation: this.db.prepare(`INSERT INTO annotations
        (id, session_id, room_id, player_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      setting: this.db.prepare('SELECT * FROM app_settings WHERE key=?'),
      insertSetting: this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'),
      upsertSetting: this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    };
  }

  transaction(work) {
    if (typeof work !== 'function') throw new TypeError('Database transaction work must be a function');
    if (work.constructor?.name === 'AsyncFunction') throw new TypeError('Database transactions must be synchronous');
    if (this.inTransaction) throw new Error('Nested database transactions are not supported');
    this.inTransaction = true;
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = work();
      if (result && typeof result.then === 'function') throw new Error('Database transactions must be synchronous');
      this.db.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      let rollbackError = null;
      if (began) {
        try { this.db.exec('ROLLBACK'); } catch (candidate) { rollbackError = candidate; }
      }
      if (rollbackError) {
        const original = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError([original, rollbackError], 'Database transaction and rollback both failed');
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  atomic(work) {
    return this.inTransaction ? work() : this.transaction(work);
  }

  insertSession(session) {
    const context = { id: session.id, game: session.game, mode: session.mode };
    this.statements.insertSession.run(session.id, session.joinCode, session.state, session.game, session.mode,
      this.writeField('sessions', 'config_json', canonicalJson(session.config), context), session.createdAt, session.updatedAt);
  }

  updateSession(session) {
    const context = { id: session.id, game: session.game, mode: session.mode };
    this.statements.updateSession.run(session.state, session.game, session.mode,
      this.writeField('sessions', 'config_json', canonicalJson(session.config), context), session.updatedAt,
      session.completedAt ?? null, session.id);
  }

  insertParticipant(participant) {
    const rosterIdentity = String(participant.rosterIdentity ?? `legacy:${participant.id}`);
    this.insertParticipantRow({
      ...participant,
      rosterIdentity,
      competitiveEligible: participant.competitiveEligible === true,
      controllerProvenance: participant.controllerProvenance ?? 'human',
    });
  }

  insertParticipantRow(participant) {
    requireString(participant.id, 'Participant id');
    requireString(participant.sessionId, 'Participant session id');
    requireString(participant.name, 'Participant name');
    const tokenHash = requireHash(participant.tokenHash, 'Participant token hash');
    requireString(participant.rosterIdentity, 'Participant roster identity');
    const controller = requireOneOf(participant.controllerProvenance ?? 'human', ['human', 'bot', 'mixed'], 'Controller provenance');
    const createdAt = normalizeIso(participant.createdAt ?? new Date().toISOString(), 'Participant creation time');
    const expiresAt = participant.authExpiresAt == null ? null : normalizeIso(participant.authExpiresAt, 'Participant token expiry');
    if (expiresAt && expiresAt <= createdAt) throw new Error('Participant token expiry must be after creation');
    const rosterIdentityHash = this.identityHash('participant', participant.rosterIdentity);
    const context = {
      id: participant.id, session_id: participant.sessionId,
      roster_identity_hash: rosterIdentityHash, token_hash: tokenHash,
    };
    this.statements.insertParticipant.run(
      participant.id,
      participant.sessionId,
      this.writeField('participants', 'name', participant.name, context),
      tokenHash,
      this.writeField('participants', 'roster_identity', participant.rosterIdentity, context),
      rosterIdentityHash,
      participant.roomId ?? null,
      participant.connected ? 1 : 0,
      participant.competitiveEligible === true ? 1 : 0,
      controller,
      expiresAt,
      createdAt,
    );
  }

  setParticipantRoom(id, roomId) {
    this.statements.updateParticipantRoom.run(roomId, id);
  }

  setParticipantConnected(id, connected) {
    this.statements.updateParticipantConnection.run(connected ? 1 : 0, id);
  }

  removeParticipant(id, removedAt = new Date().toISOString()) {
    const timestamp = normalizeIso(removedAt, 'Participant removal time');
    this.statements.removeParticipant.run(timestamp, timestamp, id);
    this.db.prepare('UPDATE web_sessions SET revoked_at=? WHERE participant_id=? AND revoked_at IS NULL')
      .run(timestamp, id);
  }

  revokeParticipantToken(id, revokedAt = new Date().toISOString()) {
    const timestamp = normalizeIso(revokedAt, 'Token revocation time');
    const participantChanges = Number(this.db.prepare(
      'UPDATE participants SET auth_revoked_at=?, is_connected=0 WHERE id=? AND auth_revoked_at IS NULL',
    ).run(timestamp, id).changes);
    this.db.prepare('UPDATE web_sessions SET revoked_at=? WHERE participant_id=? AND revoked_at IS NULL')
      .run(timestamp, id);
    return participantChanges;
  }

  revokeSessionTokens(sessionId, revokedAt = new Date().toISOString()) {
    const timestamp = normalizeIso(revokedAt, 'Token revocation time');
    const participantChanges = Number(this.db.prepare(
      'UPDATE participants SET auth_revoked_at=?, is_connected=0 WHERE session_id=? AND auth_revoked_at IS NULL',
    ).run(timestamp, sessionId).changes);
    this.db.prepare(`UPDATE web_sessions SET revoked_at=? WHERE revoked_at IS NULL AND participant_id IN
      (SELECT id FROM participants WHERE session_id=?)`).run(timestamp, sessionId);
    return participantChanges;
  }

  createStudentWebSession({
    idHash,
    sessionHash,
    participantId,
    csrfHash,
    expiresAt,
    createdAt = new Date().toISOString(),
  }) {
    const hash = requireHash(idHash ?? sessionHash, 'Web-session id hash');
    const csrf = requireHash(csrfHash, 'Web-session CSRF hash');
    const created = normalizeIso(createdAt, 'Web-session creation time');
    const expires = normalizeIso(expiresAt, 'Web-session expiry');
    if (expires <= created) throw new Error('Web-session expiry must be after creation');
    const row = {
      session_hash: hash, participant_id: requireString(participantId, 'Web-session participant'),
      csrf_hash: csrf, expires_at: expires, created_at: created,
    };
    this.db.prepare(`INSERT INTO web_sessions
      (session_hash, participant_id, csrf_hash, expires_at, created_at, binding_hash)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      row.session_hash, row.participant_id, row.csrf_hash, row.expires_at, row.created_at,
      this.webSessionBinding(row),
    );
    return this.studentWebSession(hash, created);
  }

  studentWebSession(idHash, at = new Date().toISOString()) {
    const hash = requireHash(idHash, 'Web-session id hash');
    const timestamp = normalizeIso(at, 'Web-session lookup time');
    const row = this.db.prepare(`SELECT web_sessions.* FROM web_sessions
      JOIN participants ON participants.id=web_sessions.participant_id
      WHERE web_sessions.session_hash=? AND web_sessions.revoked_at IS NULL
        AND web_sessions.expires_at>?
        AND participants.removed_at IS NULL AND participants.auth_revoked_at IS NULL
        AND (participants.auth_expires_at IS NULL OR participants.auth_expires_at>?)`).get(hash, timestamp, timestamp);
    if (row) {
      this.verifyRowIntegrity('web_sessions', row);
      this.validateWebSessionBinding(row);
    }
    return row;
  }

  revokeStudentWebSession(idHash, revokedAt = new Date().toISOString()) {
    const hash = requireHash(idHash, 'Web-session id hash');
    const timestamp = normalizeIso(revokedAt, 'Web-session revocation time');
    return Number(this.db.prepare(
      'UPDATE web_sessions SET revoked_at=? WHERE session_hash=? AND revoked_at IS NULL',
    ).run(timestamp, hash).changes);
  }

  purgeExpiredWebSessions(at = new Date().toISOString()) {
    const timestamp = normalizeIso(at, 'Web-session purge time');
    return Number(this.db.prepare(
      'DELETE FROM web_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL',
    ).run(timestamp).changes);
  }

  setParticipantCompetitiveEligible(id, eligible) {
    if (typeof eligible !== 'boolean') throw new TypeError('Competitive eligibility must be boolean');
    const row = this.db.prepare('SELECT competitive_eligible FROM participants WHERE id=?').get(id);
    if (!row) throw new Error('Participant not found');
    if (eligible && row.competitive_eligible !== 1) throw new Error('Competitive eligibility is permanent once withdrawn');
    if (!eligible && row.competitive_eligible === 1) {
      this.db.prepare('UPDATE participants SET competitive_eligible=0 WHERE id=?').run(id);
    }
    return eligible && row.competitive_eligible === 1;
  }

  saveRoom(room, serializedState) {
    const rng = room.rng.snapshot();
    const persistedPlayers = room.players.map((player) => ({
      ...player,
      actionEpoch: room.actionEpochs.get(player.id) ?? 0,
    }));
    const transcriptRoot = room.transcriptRoot ?? this.eventRoot(room.sessionId, room.id) ?? null;
    const context = {
      id: room.id, session_id: room.sessionId, seed_commitment: room.seedCommitment,
      game: room.game, mode: room.mode, sequence: room.sequence, rng_counter: rng.counter,
    };
    const result = this.statements.upsertRoom.run(
      room.id, room.sessionId, room.ordinal, room.game, room.mode, room.status, room.sequence,
      room.seedCommitment, this.writeField('rooms', 'seed_hex', rng.seedHex, context), rng.counter,
      this.writeField('rooms', 'players_json', canonicalJson(persistedPlayers), context),
      this.writeField('rooms', 'state_json', canonicalJson(serializedState), context), transcriptRoot,
      new Date().toISOString(),
    );
    if (result.changes !== 1) throw new Error('Room encryption context does not match the stored room');
  }

  setRoomTranscriptRoot(roomId, root) {
    if (root != null) requireHash(root, 'Transcript root');
    const result = this.db.prepare('UPDATE rooms SET transcript_root=? WHERE id=?').run(root, roomId);
    if (!result.changes) throw new Error('Room not found');
  }

  auditPublicKey({ format = 'pem' } = {}) {
    if (format === 'der') return this.auditPublicKeyObject.export({ format: 'der', type: 'spki' });
    if (format !== 'pem') throw new Error('Audit public-key format must be pem or der');
    return this.auditPublicKeyObject.export({ format: 'pem', type: 'spki' }).toString();
  }

  auditKeyFingerprint() {
    return crypto.createHash('sha256').update(this.auditPublicKey({ format: 'der' })).digest('hex');
  }

  signAuditRoot(sessionId, root) {
    this.verifyDatabaseIntegrity();
    return {
      algorithm: 'ed25519-v1',
      publicKey: this.auditPublicKey({ format: 'der' }).toString('base64url'),
      keyFingerprint: this.auditKeyFingerprint(),
      signedRoot: root,
      signature: crypto.sign(null, auditSignatureMessage(sessionId, root), this.auditPrivateKey).toString('base64url'),
    };
  }

  event(event) {
    return this.atomic(() => {
      const scoped = normalizeEventScope(event);
      if (!this.statements.eventSession.get(scoped.sessionId)) throw new Error('Event session does not exist');
      if (scoped.roomId !== null) {
        const room = this.statements.eventRoom.get(scoped.roomId);
        if (!room || room.session_id !== scoped.sessionId) {
          throw new Error('Room event must reference a room in the same session');
        }
      }
      if (scoped.type === 'session_audit_sealed') {
        this.verifyDatabaseIntegrity();
      }
      const id = this.nextIntegerId('events');
      const createdAt = normalizeIso(event.createdAt ?? new Date().toISOString(), 'Event creation time');
      const visibility = requireString(event.visibility ?? 'public', 'Event visibility');
      const payloadJson = canonicalJson(event.payload ?? {});
      const previous = this.db.prepare(
        'SELECT event_hash FROM events WHERE session_id=? ORDER BY id DESC LIMIT 1',
      ).get(scoped.sessionId);
      const previousHash = previous?.event_hash ?? EVENT_GENESIS_HASH;
      const row = {
        id, session_id: scoped.sessionId, room_id: scoped.roomId, sequence: scoped.sequence,
        actor_id: event.actorId == null ? null : requireString(event.actorId, 'Event actor'),
        type: scoped.type, visibility, payload_json: payloadJson, created_at: createdAt,
      };
      const eventHash = this.hashEventPayload(row, previousHash, payloadJson);
      row.event_hash = eventHash;
      this.statements.insertEvent.run(
        row.id, row.session_id, row.room_id, row.sequence, row.actor_id, row.type, row.visibility,
        this.writeField('events', 'payload_json', payloadJson, row), previousHash, eventHash, row.created_at,
      );
      return { id, previousHash, eventHash };
    });
  }

  calculateEventHash(row, previousHash, { migrationAuthority = null } = {}) {
    const version = this.cipher.envelopeVersion(row.payload_json);
    let payloadJson;
    if (version === 2) payloadJson = this.readField('events', 'payload_json', row.payload_json, row);
    else {
      requireLegacyMigrationAuthority(migrationAuthority);
      payloadJson = version === 1
        ? this.cipher.decrypt('events', 'payload_json', row.payload_json, null)
        : String(row.payload_json);
    }
    return this.hashEventPayload(row, previousHash, payloadJson);
  }

  hashEventPayload(row, previousHash, payloadJson) {
    const canonical = canonicalJson({
      actor_id: row.actor_id ?? null,
      created_at: row.created_at,
      payload: JSON.parse(payloadJson),
      room_id: row.room_id ?? null,
      sequence: row.sequence ?? null,
      session_id: row.session_id,
      type: row.type,
      visibility: row.visibility,
    });
    return crypto.createHash('sha256').update(previousHash).update('\n').update(canonical).digest('hex');
  }

  verifyEventChain(sessionId) {
    let previousHash = EVENT_GENESIS_HASH;
    let count = 0;
    const knownSession = Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId));
    const roomSessions = new Map(this.db.prepare('SELECT id, session_id FROM rooms').all()
      .map((room) => [room.id, room.session_id]));
    for (const row of this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY id').all(sessionId)) {
      let expected;
      try {
        const scoped = normalizeEventScope({
          sessionId: row.session_id, roomId: row.room_id, sequence: row.sequence, type: row.type,
        });
        if (!knownSession || (scoped.roomId !== null && roomSessions.get(scoped.roomId) !== scoped.sessionId)) {
          throw new Error('Event references an unknown session or room');
        }
        expected = this.calculateEventHash(row, previousHash);
      } catch {
        return { valid: false, count, root: previousHash, brokenEventId: row.id };
      }
      if (row.previous_hash !== previousHash || row.event_hash !== expected) {
        return { valid: false, count, root: previousHash, brokenEventId: row.id };
      }
      previousHash = row.event_hash;
      count += 1;
    }
    return { valid: true, count, root: previousHash, brokenEventId: null };
  }

  eventRoot(sessionId, roomId = null) {
    const row = roomId == null
      ? this.db.prepare('SELECT id, event_hash FROM events WHERE session_id=? ORDER BY id DESC LIMIT 1').get(sessionId)
      : this.db.prepare('SELECT id, event_hash FROM events WHERE session_id=? AND room_id=? ORDER BY id DESC LIMIT 1').get(sessionId, roomId);
    return row?.event_hash ?? null;
  }

  decision(decision) {
    return this.atomic(() => {
      const createdAt = normalizeIso(decision.createdAt ?? new Date().toISOString(), 'Decision creation time');
      const context = {
        id: this.nextIntegerId('decisions'), session_id: decision.sessionId,
        room_id: decision.roomId, player_id: decision.playerId,
        game: decision.game, created_at: createdAt,
      };
      this.statements.insertDecision.run(
        context.id, context.session_id, context.room_id, context.player_id, decision.game,
        this.writeField('decisions', 'context_json', canonicalJson(decision.context), context),
        this.writeField('decisions', 'legal_json', canonicalJson(decision.legal), context),
        this.writeField('decisions', 'action_json', canonicalJson(decision.action), context),
        this.writeField('decisions', 'benchmark_json', canonicalJson(decision.benchmark), context),
        decision.outcome == null ? null : this.writeField('decisions', 'outcome_json', canonicalJson(decision.outcome), context),
        createdAt,
      );
    });
  }

  actionExists(roomId, actionId) {
    const row = this.statements.acceptedAction.get(roomId, actionId);
    if (row) this.verifyRowIntegrity('accepted_actions', row);
    return Boolean(row);
  }

  persistedActionCounts(sessionId, roomId, playerId) {
    const player = Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM accepted_actions WHERE room_id=? AND player_id=?',
    ).get(roomId, playerId).count);
    const room = Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM accepted_actions WHERE room_id=?',
    ).get(roomId).count);
    const session = Number(this.db.prepare(`SELECT COUNT(*) AS count
      FROM accepted_actions AS accepted
      JOIN rooms ON rooms.id=accepted.room_id
      WHERE rooms.session_id=?`).get(sessionId).count);
    return { player, room, session };
  }

  recordAction(roomId, actionId, playerId) {
    this.statements.insertAcceptedAction.run(roomId, actionId, playerId, new Date().toISOString());
  }

  annotation(annotation) {
    return this.atomic(() => {
      const createdAt = normalizeIso(annotation.createdAt ?? new Date().toISOString(), 'Annotation creation time');
      const context = {
        id: this.nextIntegerId('annotations'), session_id: annotation.sessionId,
        room_id: annotation.roomId ?? null, player_id: annotation.playerId ?? null,
        kind: annotation.kind, created_at: createdAt,
      };
      this.statements.insertAnnotation.run(
        context.id, context.session_id, context.room_id, context.player_id, annotation.kind,
        this.writeField('annotations', 'note', annotation.note, context), createdAt,
      );
      return context.id;
    });
  }

  annotations(sessionId, roomId = undefined) {
    let rows;
    if (roomId === undefined) {
      rows = this.db.prepare('SELECT * FROM annotations WHERE session_id=? ORDER BY id').all(sessionId);
    } else if (roomId === null) {
      rows = this.db.prepare('SELECT * FROM annotations WHERE session_id=? AND room_id IS NULL ORDER BY id').all(sessionId);
    } else {
      rows = this.db.prepare('SELECT * FROM annotations WHERE session_id=? AND room_id=? ORDER BY id').all(sessionId, roomId);
    }
    return rows.map((row) => {
      this.verifyRowIntegrity('annotations', row);
      return { ...row, note: this.readField('annotations', 'note', row.note, row) };
    });
  }

  getOrCreateSetting(key, createValue) {
    const existing = this.statements.setting.get(key);
    if (existing) {
      this.verifyRowIntegrity('app_settings', existing);
      return this.readField('app_settings', 'value', existing.value, existing);
    }
    const value = String(createValue());
    this.statements.insertSetting.run(key, this.writeField('app_settings', 'value', value, { key }));
    const stored = this.statements.setting.get(key);
    this.verifyRowIntegrity('app_settings', stored);
    return this.readField('app_settings', 'value', stored.value, stored);
  }

  setSetting(key, value) {
    this.statements.upsertSetting.run(key, this.writeField('app_settings', 'value', String(value), { key }));
  }

  createRosterEntries(sessionId, entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('At least one roster entry is required');
    return this.atomic(() => entries.map((entry) => {
      const id = String(entry.id ?? `invite_${crypto.randomUUID()}`);
      const identityKey = requireString(entry.identityKey, 'Roster identity');
      const displayName = requireString(entry.displayName, 'Roster display name');
      const inviteHash = requireHash(entry.inviteHash, 'Roster invite hash');
      const createdAt = normalizeIso(entry.createdAt ?? new Date().toISOString(), 'Roster creation time');
      const identityHash = this.identityHash('roster', identityKey);
      const context = { id, session_id: sessionId, identity_hash: identityHash, invite_hash: inviteHash };
      this.db.prepare(`INSERT INTO roster_entries
        (id, session_id, identity_key, identity_hash, display_name, invite_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sessionId, this.writeField('roster_entries', 'identity_key', identityKey, context),
          identityHash, this.writeField('roster_entries', 'display_name', displayName, context),
          inviteHash, createdAt);
      return this.rosterEntry(id);
    }));
  }

  rosterEntry(id) {
    return this.decryptRosterRow(this.db.prepare('SELECT * FROM roster_entries WHERE id=?').get(id));
  }

  rosterEntries(sessionId) {
    return this.db.prepare('SELECT * FROM roster_entries WHERE session_id=? ORDER BY created_at, id')
      .all(sessionId).map((row) => this.decryptRosterRow(row));
  }

  rosterEntryByInviteHash(hash) {
    const inviteHash = requireHash(hash, 'Roster invite hash');
    return this.decryptRosterRow(this.db.prepare(`SELECT * FROM roster_entries
      WHERE invite_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL`).get(inviteHash));
  }

  redeemRosterInvite(inviteId, participant) {
    return this.atomic(() => {
      const entry = this.db.prepare('SELECT * FROM roster_entries WHERE id=?').get(inviteId);
      if (!entry || entry.redeemed_at || entry.revoked_at) throw new Error('Roster invitation is not available');
      const createdAt = normalizeIso(participant.createdAt ?? new Date().toISOString(), 'Participant creation time');
      const authExpiresAt = normalizeIso(participant.authExpiresAt, 'Participant token expiry');
      if (authExpiresAt <= createdAt) throw new Error('Participant token expiry must be after creation');
      const decodedEntry = this.decryptRosterRow(entry);
      const identityKey = decodedEntry.identity_key;
      const displayName = decodedEntry.display_name;
      if (participant.sessionId != null && participant.sessionId !== entry.session_id) {
        throw new Error('Roster invitation belongs to another session');
      }
      this.insertParticipantRow({
        ...participant, sessionId: entry.session_id, name: displayName, rosterIdentity: identityKey,
        authExpiresAt, competitiveEligible: true, controllerProvenance: 'human', createdAt,
      });
      const redeemed = this.db.prepare(`UPDATE roster_entries SET redeemed_at=?, participant_id=?
        WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL`).run(createdAt, participant.id, inviteId);
      if (redeemed.changes !== 1) throw new Error('Roster invitation was already used');
      return { participant: this.participant(participant.id), rosterEntry: this.rosterEntry(inviteId) };
    });
  }

  revokeRosterInvite(inviteId, revokedAt = new Date().toISOString()) {
    const timestamp = normalizeIso(revokedAt, 'Roster revocation time');
    return this.atomic(() => {
      const entry = this.db.prepare('SELECT participant_id FROM roster_entries WHERE id=?').get(inviteId);
      if (!entry) throw new Error('Roster invitation not found');
      this.db.prepare('UPDATE roster_entries SET revoked_at=? WHERE id=?').run(timestamp, inviteId);
      if (entry.participant_id) this.revokeParticipantToken(entry.participant_id, timestamp);
      return this.rosterEntry(inviteId);
    });
  }

  rotateRosterInvite(inviteId, newInviteHash, rotatedAt = new Date().toISOString()) {
    const inviteHash = requireHash(newInviteHash, 'Roster invite hash');
    normalizeIso(rotatedAt, 'Roster rotation time');
    return this.atomic(() => {
      const entry = this.db.prepare(`SELECT roster_entries.*, participants.removed_at AS participant_removed_at
        FROM roster_entries LEFT JOIN participants ON participants.id=roster_entries.participant_id
        WHERE roster_entries.id=?`).get(inviteId);
      if (!entry) throw new Error('Roster invitation not found');
      if (entry.participant_id && !entry.participant_removed_at) {
        throw new Error('Remove the active participant before rotating this invitation');
      }
      const decoded = this.decryptRosterRow(entry);
      const context = { ...entry, invite_hash: inviteHash };
      this.db.prepare(`UPDATE roster_entries SET invite_hash=?, identity_key=?, display_name=?, redeemed_at=NULL,
        participant_id=NULL, revoked_at=NULL WHERE id=?`).run(
        inviteHash,
        this.writeField('roster_entries', 'identity_key', decoded.identity_key, context),
        this.writeField('roster_entries', 'display_name', decoded.display_name, context),
        inviteId,
      );
      return this.rosterEntry(inviteId);
    });
  }

  recordControllerTransition({
    sessionId, roomId = null, playerId, participantId, controller, reason,
    actorId = 'system', sequence = null, occurredAt, createdAt,
  }) {
    const id = requireString(playerId ?? participantId, 'Controller player id');
    const nextController = requireOneOf(controller, ['human', 'bot', 'system'], 'Controller');
    const timestamp = normalizeIso(occurredAt ?? createdAt ?? new Date().toISOString(), 'Controller transition time');
    const transitionActor = requireString(actorId, 'Controller transition actor');
    return this.atomic(() => {
      const participant = this.db.prepare(
        'SELECT session_id, controller_provenance FROM participants WHERE id=?',
      ).get(id);
      if (participant && participant.session_id !== sessionId) throw new Error('Participant belongs to another session');
      if (participant) {
        const summary = participant.controller_provenance === nextController
          ? participant.controller_provenance
          : 'mixed';
        this.db.prepare(`UPDATE participants SET controller_provenance=?,
          competitive_eligible=CASE WHEN ? IN ('bot','system') THEN 0 ELSE competitive_eligible END WHERE id=?`)
          .run(summary, nextController, id);
      }
      const context = {
        id: this.nextIntegerId('controller_events'), session_id: sessionId,
        room_id: roomId, player_id: id, controller: nextController,
        actor_id: transitionActor, sequence, occurred_at: timestamp,
      };
      this.db.prepare(`INSERT INTO controller_events
        (id, session_id, room_id, player_id, controller, reason, actor_id, sequence, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(context.id, sessionId, roomId, id, nextController,
          this.writeField('controller_events', 'reason', requireString(reason, 'Controller transition reason'), context),
          transitionActor, sequence, timestamp);
      return this.decryptControllerRow(this.db.prepare('SELECT * FROM controller_events WHERE id=?').get(context.id));
    });
  }

  controllerTransitions(sessionId, playerId = null) {
    const rows = playerId == null
      ? this.db.prepare('SELECT * FROM controller_events WHERE session_id=? ORDER BY id').all(sessionId)
      : this.db.prepare('SELECT * FROM controller_events WHERE session_id=? AND player_id=? ORDER BY id').all(sessionId, playerId);
    return rows.map((row) => this.decryptControllerRow(row));
  }

  recordResultProvenance({
    sessionId, roomId, playerId, controllerSummary, competitiveEligible, result,
    transcriptRoot = null, createdAt = new Date().toISOString(),
  }) {
    const timestamp = normalizeIso(createdAt, 'Result creation time');
    if (transcriptRoot != null) requireHash(transcriptRoot, 'Transcript root');
    return this.atomic(() => {
      const participant = this.db.prepare(
        'SELECT controller_provenance, competitive_eligible FROM participants WHERE id=? AND session_id=?',
      ).get(playerId, sessionId);
      const summary = requireOneOf(controllerSummary ?? participant?.controller_provenance ?? 'bot',
        ['human', 'bot', 'mixed'], 'Controller summary');
      const eligible = competitiveEligible ?? (participant?.competitive_eligible === 1);
      if (typeof eligible !== 'boolean') throw new TypeError('Result competitive eligibility must be boolean');
      const resultJson = canonicalJson(result);
      const existing = this.db.prepare('SELECT * FROM result_provenance WHERE room_id=? AND player_id=?').get(roomId, playerId);
      if (existing) {
        const decoded = this.decryptResultRow(existing);
        if (decoded.session_id !== sessionId || decoded.controller_summary !== summary
          || decoded.competitive_eligible !== (eligible ? 1 : 0)
          || decoded.result_json !== resultJson || decoded.transcript_root !== transcriptRoot) {
          throw new Error('Result provenance is immutable');
        }
        return decoded;
      }
      const context = {
        id: this.nextIntegerId('result_provenance'), session_id: sessionId,
        room_id: roomId, player_id: playerId, controller_summary: summary,
        competitive_eligible: eligible ? 1 : 0, transcript_root: transcriptRoot,
        created_at: timestamp,
      };
      this.db.prepare(`INSERT INTO result_provenance
        (id, session_id, room_id, player_id, controller_summary, competitive_eligible,
         result_json, transcript_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(context.id, sessionId, roomId, playerId, summary, eligible ? 1 : 0,
          this.writeField('result_provenance', 'result_json', resultJson, context), transcriptRoot, timestamp);
      return this.decryptResultRow(this.db.prepare('SELECT * FROM result_provenance WHERE id=?').get(context.id));
    });
  }

  resultProvenance(sessionId, roomId = null) {
    const rows = roomId == null
      ? this.db.prepare('SELECT * FROM result_provenance WHERE session_id=? ORDER BY room_id, player_id').all(sessionId)
      : this.db.prepare('SELECT * FROM result_provenance WHERE session_id=? AND room_id=? ORDER BY player_id').all(sessionId, roomId);
    return rows.map((row) => this.decryptResultRow(row));
  }

  activeSession() {
    return this.decryptSessionRow(this.db.prepare(
      `SELECT * FROM sessions WHERE state NOT IN ('archived') ORDER BY created_at DESC LIMIT 1`,
    ).get());
  }

  sessionByJoinCode(joinCode) {
    return this.decryptSessionRow(this.db.prepare(
      `SELECT * FROM sessions WHERE join_code=? AND state IN ('lobby','locked','running','paused','pausing','resuming','ending','voiding')`,
    ).get(joinCode));
  }

  session(id) {
    return this.decryptSessionRow(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
  }

  joinCodeExists(joinCode) {
    return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE join_code=?').get(joinCode));
  }

  participant(id) {
    return this.decryptParticipantRow(this.db.prepare('SELECT * FROM participants WHERE id=?').get(id));
  }

  participantByTokenHash(hash, at = new Date().toISOString()) {
    const timestamp = normalizeIso(at, 'Authentication time');
    return this.decryptParticipantRow(this.db.prepare(`SELECT * FROM participants
      WHERE token_hash=? AND removed_at IS NULL AND auth_revoked_at IS NULL
        AND (auth_expires_at IS NULL OR auth_expires_at>?)`).get(hash, timestamp));
  }

  participants(sessionId) {
    return this.db.prepare(`SELECT * FROM participants WHERE session_id=? AND removed_at IS NULL ORDER BY created_at`)
      .all(sessionId).map((row) => this.decryptParticipantRow(row));
  }

  rooms(sessionId) {
    return this.db.prepare(`SELECT * FROM rooms WHERE session_id=? ORDER BY ordinal IS NULL, ordinal, id`)
      .all(sessionId).map((row) => this.decryptRoomRow(row));
  }

  room(id) {
    return this.decryptRoomRow(this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id));
  }

  decisions(sessionId, playerId) {
    return this.db.prepare(`SELECT * FROM decisions WHERE session_id=? AND player_id=? ORDER BY id`)
      .all(sessionId, playerId).map((row) => this.decryptDecisionRow(row));
  }

  events(sessionId, roomId = null) {
    const rows = roomId
      ? this.db.prepare(`SELECT * FROM events WHERE session_id=? AND room_id=? ORDER BY id`).all(sessionId, roomId)
      : this.db.prepare(`SELECT * FROM events WHERE session_id=? ORDER BY id`).all(sessionId);
    return rows.map((row) => {
      this.verifyRowIntegrity('events', row);
      return { ...row, payload_json: this.readField('events', 'payload_json', row.payload_json, row) };
    });
  }

  retentionCandidates(cutoff) {
    const timestamp = normalizeIso(cutoff, 'Retention cutoff');
    return this.db.prepare(`SELECT id, state, created_at, completed_at, updated_at FROM sessions
      WHERE state IN ('completed','voided','archived') AND COALESCE(completed_at, updated_at) < ?
      ORDER BY COALESCE(completed_at, updated_at), id`).all(timestamp);
  }

  purgeSession(sessionId, { compact = true } = {}) {
    if (this.inTransaction) throw new Error('Session purge must own its transaction');
    const counts = this.transaction(() => {
      const session = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId);
      if (!session) return null;
      if (!TERMINAL_SESSION_STATES.has(session.state)) throw new Error('Only terminal sessions can be purged');
      return this.deleteSessionRows(sessionId);
    });
    if (counts && compact) this.compactSensitiveData();
    return counts;
  }

  purgeTerminalSessionsBefore(cutoff, { compact = true } = {}) {
    if (this.inTransaction) throw new Error('Retention purge must own its transaction');
    const candidates = this.retentionCandidates(cutoff);
    const purged = this.transaction(() => candidates.map(({ id }) => ({ sessionId: id, ...this.deleteSessionRows(id) })));
    if (purged.length && compact) this.compactSensitiveData();
    return purged;
  }

  purgeCompletedSessions({
    before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    excludeSessionId = null,
    compact = true,
  } = {}) {
    if (this.inTransaction) throw new Error('Retention purge must own its transaction');
    const cutoff = normalizeIso(before, 'Retention cutoff');
    const candidates = this.retentionCandidates(cutoff)
      .filter(({ id }) => id !== excludeSessionId);
    const purged = this.transaction(() => candidates.map(({ id }) => this.deleteSessionRows(id)));
    if (purged.length && compact) this.compactSensitiveData();
    const counts = {};
    for (const item of purged) {
      for (const [name, count] of Object.entries(item.counts)) counts[name] = (counts[name] ?? 0) + count;
    }
    return { before: cutoff, excludedSessionId: excludeSessionId, sessions: purged.length, counts, purged };
  }

  deleteSessionRows(sessionId) {
    const counts = {};
    const remove = (name, sql, ...parameters) => {
      counts[name] = Number(this.db.prepare(sql).run(...parameters).changes);
    };
    remove('acceptedActions', `DELETE FROM accepted_actions WHERE room_id IN (SELECT id FROM rooms WHERE session_id=?)`, sessionId);
    remove('annotations', 'DELETE FROM annotations WHERE session_id=?', sessionId);
    remove('decisions', 'DELETE FROM decisions WHERE session_id=?', sessionId);
    remove('resultProvenance', 'DELETE FROM result_provenance WHERE session_id=?', sessionId);
    remove('controllerEvents', 'DELETE FROM controller_events WHERE session_id=?', sessionId);
    remove('events', 'DELETE FROM events WHERE session_id=?', sessionId);
    remove('rosterEntries', 'DELETE FROM roster_entries WHERE session_id=?', sessionId);
    remove('webSessions', `DELETE FROM web_sessions WHERE participant_id IN
      (SELECT id FROM participants WHERE session_id=?)`, sessionId);
    remove('participants', 'DELETE FROM participants WHERE session_id=?', sessionId);
    remove('rooms', 'DELETE FROM rooms WHERE session_id=?', sessionId);
    remove('sessions', 'DELETE FROM sessions WHERE id=?', sessionId);
    return { sessionId, counts };
  }

  compactSensitiveData() {
    if (this.inTransaction) throw new Error('Database compaction cannot run inside a transaction');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    if (!this.ephemeral) protectDatabaseFile(this.filename);
  }

  identityHash(namespace, value) {
    return this.cipher.index(namespace, String(value));
  }

  webSessionBinding(row) {
    return this.cipher.index('web-session-binding', canonicalJson({
      created_at: row.created_at,
      csrf_hash: row.csrf_hash,
      expires_at: row.expires_at,
      participant_id: row.participant_id,
      session_hash: row.session_hash,
    }));
  }

  validateWebSessionBinding(row) {
    const expected = this.webSessionBinding(row);
    if (typeof row.binding_hash !== 'string' ||
        !safeEqualText(row.binding_hash, expected)) {
      throw new Error('Student web-session ownership binding could not be authenticated');
    }
  }

  assertWebSessionBindings() {
    for (const row of this.db.prepare('SELECT * FROM web_sessions').all()) {
      this.validateWebSessionBinding(row);
    }
  }

  nextIntegerId(table) {
    if (!INTEGER_ID_TABLES.has(table)) throw new Error(`Table ${table} does not use allocated integer identities`);
    const value = Number(this.db.prepare(
      `SELECT MAX(COALESCE(MAX(id), 0),
        COALESCE((SELECT seq FROM sqlite_sequence WHERE name=?), 0)) + 1 AS next_id
       FROM ${quoteIdentifier(table)}`,
    ).get(table).next_id);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Cannot allocate a safe row identity for ${table}`);
    return value;
  }

  writeField(table, column, value, row) {
    return value == null ? null : this.cipher.encrypt(table, column, String(value), encryptionContext(table, row));
  }

  readField(table, column, value, row) {
    if (value == null) return null;
    const context = encryptionContext(table, row);
    requireV2Envelope(this.cipher, table, column, value);
    return this.cipher.decrypt(table, column, value, context);
  }

  decryptSessionRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('sessions', row);
    return { ...row, config_json: this.readField('sessions', 'config_json', row.config_json, row) };
  }

  decryptParticipantRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('participants', row);
    const decoded = {
      ...row,
      name: this.readField('participants', 'name', row.name, row),
      roster_identity: this.readField('participants', 'roster_identity', row.roster_identity, row),
    };
    this.validateFieldCommitment('participants', 'roster_identity', decoded.roster_identity, row);
    return decoded;
  }

  decryptRoomRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('rooms', row);
    const decoded = {
      ...row,
      seed_hex: this.readField('rooms', 'seed_hex', row.seed_hex, row),
      players_json: this.readField('rooms', 'players_json', row.players_json, row),
      state_json: this.readField('rooms', 'state_json', row.state_json, row),
    };
    if (decoded.seed_hex != null) this.validateFieldCommitment('rooms', 'seed_hex', decoded.seed_hex, row);
    this.validateRoomEventHead(row);
    return decoded;
  }

  decryptDecisionRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('decisions', row);
    const decoded = { ...row };
    for (const field of ['context_json', 'legal_json', 'action_json', 'benchmark_json', 'outcome_json']) {
      decoded[field] = this.readField('decisions', field, row[field], row);
    }
    return decoded;
  }

  decryptRosterRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('roster_entries', row);
    const decoded = {
      ...row,
      identity_key: this.readField('roster_entries', 'identity_key', row.identity_key, row),
      display_name: this.readField('roster_entries', 'display_name', row.display_name, row),
    };
    this.validateFieldCommitment('roster_entries', 'identity_key', decoded.identity_key, row);
    return decoded;
  }

  decryptControllerRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('controller_events', row);
    return { ...row, reason: this.readField('controller_events', 'reason', row.reason, row) };
  }

  decryptResultRow(row) {
    if (!row) return row;
    this.verifyRowIntegrity('result_provenance', row);
    return { ...row, result_json: this.readField('result_provenance', 'result_json', row.result_json, row) };
  }

  close() {
    this.db.close();
    if (!this.ephemeral) protectDatabaseFile(this.filename);
  }
}

class FieldCipher {
  constructor(value) {
    this.key = normalizeEncryptionKey(value);
  }

  envelopeVersion(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^enc:v(\d+):/);
    return match ? Number(match[1]) : null;
  }

  isEnvelope(value) {
    return this.envelopeVersion(value) != null;
  }

  encrypt(table, column, plaintext, context) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(fieldAad(2, table, column, context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v2:${nonce.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
  }

  decrypt(table, column, envelope, context) {
    const parts = envelope.split(':');
    const version = this.envelopeVersion(envelope);
    if (parts.length !== 5 || parts[0] !== 'enc' || ![1, 2].includes(version) || parts[1] !== `v${version}`) {
      throw new Error(`Invalid encrypted ${table}.${column} value`);
    }
    try {
      const nonce = Buffer.from(parts[2], 'base64url');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      const tag = Buffer.from(parts[4], 'base64url');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(version === 1
        ? Buffer.from(`agentic-trading-games:v1:${table}:${column}`, 'utf8')
        : fieldAad(2, table, column, context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`Encrypted ${table}.${column} could not be authenticated; the data key is wrong or the database was altered`);
    }
  }

  index(namespace, value) {
    return crypto.createHmac('sha256', this.key)
      .update(`agentic-trading-games:index:v1:${namespace}\0`).update(value).digest('hex');
  }
}

function encryptionContext(table, row) {
  const fields = ENCRYPTION_CONTEXT_FIELDS[table];
  if (!fields) throw new Error(`No encryption context is defined for ${table}`);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Encrypted ${table} value requires its immutable row context`);
  }
  const context = {};
  for (const [column, kind] of fields) {
    if (!Object.hasOwn(row, column) || row[column] === undefined) {
      throw new Error(`Encrypted ${table} value requires row context ${column}`);
    }
    const value = row[column];
    if (kind === 'nullable-text' && value == null) {
      context[column] = null;
    } else if (kind === 'nullable-nonnegative-integer' && value == null) {
      context[column] = null;
    } else if (kind === 'integer' || kind === 'nonnegative-integer' ||
               kind === 'nullable-nonnegative-integer' || kind === 'boolean-integer') {
      const integer = Number(value);
      const minimum = kind === 'integer' ? 1 : 0;
      const validBoolean = kind !== 'boolean-integer' || integer === 0 || integer === 1;
      if (!Number.isSafeInteger(integer) || integer < minimum || !validBoolean) {
        throw new Error(`Encrypted ${table} value has invalid row context ${column}`);
      }
      context[column] = integer;
    } else {
      if (value == null || String(value).length === 0) {
        throw new Error(`Encrypted ${table} value has invalid row context ${column}`);
      }
      context[column] = String(value);
    }
  }
  return canonicalJson(context);
}

function fieldAad(version, table, column, context) {
  if (version !== 2 || typeof context !== 'string' || !context) {
    throw new Error(`Encrypted ${table}.${column} value requires authenticated row context`);
  }
  return Buffer.from(`agentic-trading-games:v2\0${table}\0${column}\0${context}`, 'utf8');
}

function requireLegacyMigrationAuthority(authority) {
  if (authority !== TRUSTED_LEGACY_MIGRATION) {
    throw new Error('Legacy or unencrypted protected data is rejected; after verifying the database and stopping ' +
      'the application, use scripts/migrate-database-encryption.mjs --trusted-offline-source');
  }
}

function requireV2Envelope(cipher, table, column, value) {
  if (cipher.envelopeVersion(value) !== 2) {
    throw new Error(`Protected ${table}.${column} data is not an authenticated enc:v2 envelope; ` +
      'verified legacy databases require the stopped-application scripts/migrate-database-encryption.mjs command');
  }
}

function safeEqualText(left, right) {
  const leftBytes = Buffer.from(String(left), 'utf8');
  const rightBytes = Buffer.from(String(right), 'utf8');
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function normalizeIntegrityValue(value) {
  if (value == null) return ['null'];
  if (typeof value === 'string') return ['text', value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64url')];
  throw new Error('Database integrity encountered an unsupported SQLite value');
}

function xorIntegrityHex(left, right) {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) {
    throw new Error('Database integrity XOR inputs must be SHA-256 hex values');
  }
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  const output = Buffer.allocUnsafe(32);
  for (let index = 0; index < output.length; index += 1) output[index] = leftBytes[index] ^ rightBytes[index];
  return output.toString('hex');
}

function normalizeEncryptionKey(value) {
  if (value == null || value === '') {
    throw new Error('A 32-byte database encryption key is required (Database encryptionKey or AGENTIC_DATA_KEY)');
  }
  let key;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) key = Buffer.from(value);
  else if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else if (typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) {
    key = Buffer.from(value, 'base64');
  }
  else throw new TypeError('Database encryption key must be a 32-byte buffer, base64 string, or 64-character hex string');
  if (key.length !== 32) throw new Error('Database encryption key must decode to exactly 32 bytes');
  return key;
}

function protectDataDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function protectDatabaseFile(filename) {
  if (process.platform !== 'win32' && fs.existsSync(filename)) fs.chmodSync(filename, 0o600);
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((column) => column.name));
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe SQL identifier');
  return `"${value}"`;
}

function canonicalJson(value) {
  const result = JSON.stringify(canonicalValue(value));
  if (result === undefined) throw new TypeError('Value cannot be represented as canonical JSON');
  return result;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('BigInt cannot be represented as JSON');
  if (Array.isArray(value)) return value.map((item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return null;
    return canonicalValue(item);
  });
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') return canonicalValue(value.toJSON());
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      output[key] = canonicalValue(item);
    }
    return output;
  }
  return undefined;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeEventScope(event) {
  const sessionId = requireString(event.sessionId, 'Event session');
  const type = requireString(event.type, 'Event type');
  const sessionScoped = SESSION_EVENT_TYPES.has(type);
  const roomScoped = ROOM_EVENT_TYPES.has(type);
  if (sessionScoped === roomScoped) throw new Error(`Unsupported event type: ${type}`);
  if (sessionScoped) {
    if (event.roomId != null || event.sequence != null) {
      throw new Error(`Session event ${type} must have null room and sequence`);
    }
    return { sessionId, roomId: null, sequence: null, type };
  }
  const roomId = requireString(event.roomId, 'Room event room id');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error(`Room event ${type} requires a positive integer sequence`);
  }
  return { sessionId, roomId, sequence: event.sequence, type };
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value.toLowerCase())) {
    throw new Error(`${label} must be a 64-character SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function requireOneOf(value, options, label) {
  if (!options.includes(value)) throw new Error(`${label} must be one of: ${options.join(', ')}`);
  return value;
}

function normalizeIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function compareVersions(a, b) {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let index = 0; index < Math.max(aa.length, bb.length); index += 1) {
    const delta = (aa[index] ?? 0) - (bb[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}
