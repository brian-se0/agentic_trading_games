import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Database, defaultDatabasePath } from './db.js';
import { Platform } from './platform.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
const publicRoot = path.join(projectRoot, 'public');
const publicAssets = new Map(['index.html', 'app.js', 'instructor.html', 'instructor.js', 'styles.css']
  .map((filename) => [filename, fs.readFileSync(path.join(publicRoot, filename))]));
const STUDENT_COOKIE = 'atg_student_session';
const STUDENT_CSRF_COOKIE = 'atg_student_csrf';
const INSTRUCTOR_COOKIE = 'atg_instructor_session';
// A fixed class-day lifetime covers the longest supported exercise without
// creating a renewable credential that can silently outlive the process/day.
const STUDENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INSTRUCTOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const SSE_BUFFER_LIMIT = 256 * 1024;

export function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHost(host = '') {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isWildcardHost(host = '') {
  return host === '' || host === '0.0.0.0' || (net.isIP(host) === 6 && /^[0:]+$/.test(host));
}

function ipv4Number(address) {
  const normalized = String(address).replace(/^::ffff:/, '');
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
  return octets.reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function parseIpv4Cidr(cidr) {
  if (!cidr) return null;
  const [address, prefixText, ...extra] = String(cidr).split('/');
  const prefix = Number(prefixText);
  const network = ipv4Number(address);
  if (extra.length || network == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('studentAllowedCidr must be an IPv4 CIDR');
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (network & mask) >>> 0, mask, prefix };
}

const PRIVATE_IPV4_BLOCKS = [
  { network: ipv4Number('10.0.0.0'), mask: 0xff000000, prefix: 8 },
  { network: ipv4Number('172.16.0.0'), mask: 0xfff00000, prefix: 12 },
  { network: ipv4Number('192.168.0.0'), mask: 0xffff0000, prefix: 16 },
];

function privateIpv4Block(address) {
  const candidate = ipv4Number(address);
  return candidate == null ? null : PRIVATE_IPV4_BLOCKS.find((block) =>
    ((candidate & block.mask) >>> 0) === block.network) ?? null;
}

function inIpv4Cidr(address, cidr) {
  if (!cidr) return true;
  const candidate = ipv4Number(address);
  return candidate != null && ((candidate & cidr.mask) >>> 0) === cidr.network;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PUBLIC_VALIDATION_MESSAGES = new Set([
  'At least one roster entry is required',
  'At least one student must join',
  'Complete or void the current session before creating another',
  'Create a session first',
  'Duplicate action',
  'Each roster entry requires identity and name',
  'Each roster entry requires only identity and name',
  'Invalid action epoch',
  'Invalid action identifier',
  'Invalid invitation',
  'Invalid join code',
  'Invalid or already used invitation',
  'Invitation is not eligible for revocation',
  'Invitation is not eligible for rotation',
  'Invitations can only be revoked in the lobby',
  'Invitations can only be rotated in the lobby',
  'No assigned room',
  'No game data for participant',
  'No session',
  'Only an active table can be voided',
  'Participant is not assigned',
  'Participant not found',
  'Participants can only be removed in the lobby',
  'Room not found',
  'Rooms can only be voided during an active session',
  'Roster entries can only be added in the lobby',
  'Roster identities must be unique',
  'Roster must be an array',
  'Seat is currently controlled by a bot',
  'Seats can only be changed at an active, healthy table',
  'Seats can only be changed during an active session',
  'Session capacity reached',
  'Session is not in the lobby',
  'Session is not paused',
  'Session is not running',
  'Stale action: this game screen has already changed',
  'The coaching packet is available after the room is complete',
  'The roster is not open',
  'The student must reconnect before the seat can be restored',
  'Unknown game',
  'Unknown mode',
]);

class TokenBuckets {
  constructor({ capacity, refillPerSecond, maximumEntries = 5_000 }) {
    this.capacity = capacity;
    this.refillPerMillisecond = refillPerSecond / 1000;
    this.maximumEntries = maximumEntries;
    this.buckets = new Map();
  }

  take(key, currentTime = Date.now()) {
    let previous = this.buckets.get(key);
    if (previous) {
      // Map insertion order gives us a compact O(1) LRU without a second index.
      this.buckets.delete(key);
    } else if (this.buckets.size >= this.maximumEntries) {
      this.buckets.delete(this.buckets.keys().next().value);
    }
    previous ??= { tokens: this.capacity, updatedAt: currentTime };
    const elapsed = Math.max(0, currentTime - previous.updatedAt);
    const tokens = Math.min(this.capacity, previous.tokens + elapsed * this.refillPerMillisecond);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: currentTime });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: currentTime });
    return true;
  }
}

function parseCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    try {
      result[decodeURIComponent(item.slice(0, separator).trim())] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return result;
}

function sessionCookie(name, value, { secure = false, maxAgeSeconds = 0, httpOnly = true } = {}) {
  return `${name}=${encodeURIComponent(value)}; ${httpOnly ? 'HttpOnly; ' : ''}SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function clearCookie(name, secure = false, httpOnly = true) {
  return sessionCookie(name, '', { secure, maxAgeSeconds: 0, httpOnly });
}

function secretHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Content-Length': 0, ...headers });
  res.end();
}

function securityHeaders(res, { secure = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function contentType(filename) {
  const extension = path.extname(filename);
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  })[extension] ?? 'application/octet-stream';
}

async function readJson(req, maximumBytes) {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new HttpError(413, 'Request body is too large');
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximumBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, 'Request body is too large');
  if (!chunks.length) throw new HttpError(400, 'A JSON object is required');
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required');
  return body;
}

async function readEmptyJson(req, maximumBytes = 64) {
  const body = await readJson(req, maximumBytes);
  if (Object.keys(body).length) throw new HttpError(400, 'This endpoint requires an empty JSON object');
  return body;
}

function requireOptionalNote(body) {
  if (Object.keys(body).some((key) => key !== 'note') || (body.note != null && typeof body.note !== 'string')) {
    throw new HttpError(400, 'Only a text note is allowed');
  }
  return body.note;
}

function requestIp(req) {
  return String(req.socket.remoteAddress ?? 'unknown');
}

function clientAddressKey(address) {
  const raw = String(address ?? 'unknown').split('%', 1)[0].toLowerCase();
  return raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? raw;
}

function requestClientKey(req) {
  return clientAddressKey(requestIp(req));
}

function requestAddressKey(req) {
  return clientAddressKey(requestIp(req));
}

function requestHasBody(req) {
  return req.headers['transfer-encoding'] != null || Number(req.headers['content-length'] ?? 0) > 0;
}

function authority(host, port) {
  const renderedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${renderedHost}:${port}`;
}

function listenerOrigin(server, { protocol, host, publicOrigin }) {
  if (publicOrigin) return new URL(publicOrigin).origin;
  const address = server.address();
  if (!address || typeof address === 'string') return null;
  return `${protocol}://${authority(host, address.port)}`;
}

function hasCanonicalHost(req, origin) {
  if (!origin) return false;
  return String(req.headers.host ?? '').toLowerCase() === new URL(origin).host.toLowerCase();
}

function hasCanonicalOrigin(req, origin) {
  if (!origin) return false;
  try {
    return new URL(String(req.headers.origin ?? '')).origin === origin;
  } catch {
    return false;
  }
}

function sameOriginBrowserGet(req, origin) {
  if (req.headers.origin != null) return hasCanonicalOrigin(req, origin);
  try {
    return req.headers['sec-fetch-site'] === 'same-origin' && new URL(String(req.headers.referer ?? '')).origin === origin;
  } catch {
    return false;
  }
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicErrorStatus(error) {
  if (error instanceof HttpError) return error.status;
  if (error?.name === 'GameActionError') return 400;
  if (error?.name === 'StateConflictError') return 409;
  if (error?.name === 'RateLimitError') return 429;
  const message = String(error?.message ?? '');
  if (PUBLIC_VALIDATION_MESSAGES.has(message) ||
      /^(?:Rounds|Trading duration|Turn deadline) must be an integer from \d+ to \d+(?: seconds)?$/.test(message)) return 400;
  return 500;
}

function sendError(res, error, errorLogger) {
  const status = publicErrorStatus(error);
  if (status === 500) {
    const incidentId = crypto.randomUUID();
    try { errorLogger?.({ incidentId, error }); } catch { /* Logging must not expose or replace the generic response. */ }
    return json(res, 500, { error: 'Internal server error', incidentId });
  }
  return json(res, status, { error: String(error.message) });
}

function configureServer(server, maximumConnections) {
  server.maxConnections = maximumConnections;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
}

function capConnectionsPerIp(server, maximumPerIp) {
  const counts = new Map();
  server.on('connection', (socket) => {
    const address = clientAddressKey(socket.remoteAddress);
    const next = (counts.get(address) ?? 0) + 1;
    counts.set(address, next);
    socket.once('close', () => {
      const remaining = (counts.get(address) ?? 1) - 1;
      if (remaining > 0) counts.set(address, remaining);
      else counts.delete(address);
    });
    if (next > maximumPerIp) socket.destroy();
  });
}

function restrictListenHost(server, expectedHost, label) {
  const listen = server.listen;
  server.listen = function securedListen(...args) {
    const options = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const suppliedHost = options ? options.host : typeof args[1] === 'string' ? args[1] : null;
    if (suppliedHost !== expectedHost) throw new Error(`${label} must bind explicitly to ${expectedHost}`);
    return listen.apply(this, args);
  };
}

export function createApplication({
  databasePath = defaultDatabasePath(),
  studentHost = '127.0.0.1',
  studentPublicOrigin = null,
  studentAllowedCidr = null,
  tls = null,
  encryptionKey = null,
  errorLogger = ({ incidentId, error }) => console.error(`[${incidentId}]`, error),
  now = () => Date.now(),
} = {}) {
  if (isWildcardHost(studentHost)) throw new Error('studentHost must select one interface and cannot be a wildcard');
  if (net.isIP(studentHost) !== 4) throw new Error('studentHost must be an explicit IPv4 interface address');
  if (!isLoopbackHost(studentHost) && !tls) throw new Error('TLS key and certificate are required for a non-loopback student listener');
  if (tls && (!tls.key || !tls.cert)) throw new Error('TLS options must include an explicit key and certificate');
  if (tls?.minVersion && !['TLSv1.2', 'TLSv1.3'].includes(tls.minVersion)) {
    throw new Error('TLS minVersion must be TLSv1.2 or TLSv1.3');
  }
  if (tls && !studentPublicOrigin) throw new Error('studentPublicOrigin is required when TLS is enabled');
  if (studentPublicOrigin) {
    const parsed = new URL(studentPublicOrigin);
    const expectedProtocol = tls ? 'https:' : 'http:';
    if (parsed.protocol !== expectedProtocol) throw new Error(`studentPublicOrigin must use ${expectedProtocol.slice(0, -1)}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('studentPublicOrigin must contain only scheme and authority');
    }
  }
  const allowedStudentCidr = parseIpv4Cidr(studentAllowedCidr);
  if (!isLoopbackHost(studentHost)) {
    const privateBlock = privateIpv4Block(studentHost);
    if (!privateBlock) throw new Error('studentHost must be an RFC1918 private IPv4 address');
    if (!allowedStudentCidr) throw new Error('studentAllowedCidr is required for a non-loopback student listener');
    if (!inIpv4Cidr(studentHost, allowedStudentCidr)) {
      throw new Error('studentHost must belong to studentAllowedCidr');
    }
    if (allowedStudentCidr.prefix < privateBlock.prefix ||
        ((allowedStudentCidr.network & privateBlock.mask) >>> 0) !== privateBlock.network) {
      throw new Error('studentAllowedCidr must stay entirely within the studentHost RFC1918 private network');
    }
  }

  const db = new Database(databasePath, { encryptionKey });
  let platform;
  try {
    platform = new Platform(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const instructorSessions = new Map();
  const studentStreams = new Map();
  const instructorStreams = new Map();
  const pendingStudents = new Map();
  const bootstrapToken = crypto.randomBytes(32).toString('base64url');
  const bootstrapHash = crypto.createHash('sha256').update(bootstrapToken).digest();
  const bootstrapExpiresAt = now() + BOOTSTRAP_TTL_MS;
  const joinLimit = new TokenBuckets({ capacity: 8, refillPerSecond: 8 / 60 });
  const globalJoinLimit = new TokenBuckets({ capacity: 300, refillPerSecond: 5 });
  const actionIpLimit = new TokenBuckets({ capacity: 40, refillPerSecond: 30 });
  const actionIdentityLimit = new TokenBuckets({ capacity: 12, refillPerSecond: 8 });
  const streamLimit = new TokenBuckets({ capacity: 6, refillPerSecond: 1 / 5 });
  const studentRequestLimit = new TokenBuckets({ capacity: 120, refillPerSecond: 60 });
  const globalStudentRequestLimit = new TokenBuckets({ capacity: 2_000, refillPerSecond: 1_000 });
  const instructorRequestLimit = new TokenBuckets({ capacity: 240, refillPerSecond: 120 });
  const exportLimit = new TokenBuckets({ capacity: 6, refillPerSecond: 1 / 10 });
  const activeStudentRequests = new Map();
  let bootstrapUsed = false;
  let studentFlushTimer = null;
  let instructorFlushTimer = null;
  let closing = false;
  const studentSecure = Boolean(tls);
  let studentServer;
  let instructorServer;

  function studentOrigin() {
    return listenerOrigin(studentServer, { protocol: studentSecure ? 'https' : 'http', host: studentHost, publicOrigin: studentPublicOrigin });
  }

  function acquireStudentRequest(req) {
    const address = requestAddressKey(req);
    // Always charge the narrowest bucket first. Traffic already rejected for one
    // client must not consume capacity reserved for the rest of the classroom.
    if (!studentRequestLimit.take(address, now())) throw new HttpError(429, 'Request rate limit exceeded');
    if (!globalStudentRequestLimit.take('all-students', now())) throw new HttpError(429, 'Server request capacity reached');
    const active = activeStudentRequests.get(address) ?? 0;
    if (active >= 16) throw new HttpError(429, 'Too many concurrent requests');
    activeStudentRequests.set(address, active + 1);
    return () => {
      const remaining = (activeStudentRequests.get(address) ?? 1) - 1;
      if (remaining > 0) activeStudentRequests.set(address, remaining);
      else activeStudentRequests.delete(address);
    };
  }

  function instructorOrigin() {
    return listenerOrigin(instructorServer, { protocol: 'http', host: '127.0.0.1', publicOrigin: null });
  }

  function prepareStudentSession() {
    const createdAt = now();
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    return {
      id,
      idHash: secretHash(id),
      csrf,
      csrfHash: secretHash(csrf),
      expiresAt: createdAt + STUDENT_SESSION_TTL_MS,
      createdAt,
    };
  }

  function persistedStudentSession(record, participantId) {
    return {
      idHash: record.idHash,
      ...(participantId ? { participantId } : {}),
      csrfHash: record.csrfHash,
      expiresAt: new Date(record.expiresAt).toISOString(),
      createdAt: new Date(record.createdAt).toISOString(),
    };
  }

  function replaceStudentSession(previous, participantId) {
    const replacement = prepareStudentSession();
    db.transaction(() => {
      db.createStudentWebSession(persistedStudentSession(replacement, participantId));
      db.revokeStudentWebSession(previous.idHash, new Date(now()).toISOString());
    });
    return replacement;
  }

  function getStudentSession(req) {
    const id = parseCookies(req)[STUDENT_COOKIE];
    if (!id) return null;
    const idHash = secretHash(id);
    const row = db.studentWebSession(idHash, new Date(now()).toISOString());
    return row ? {
      id,
      idHash,
      participantId: row.participant_id,
      csrfHash: row.csrf_hash,
      expiresAt: Date.parse(row.expires_at),
    } : null;
  }

  function browserCsrf(req, record) {
    const value = parseCookies(req)[STUDENT_CSRF_COOKIE];
    return value && equalSecret(secretHash(value), record.csrfHash) ? value : null;
  }

  function studentCookieHeaders(record) {
    return [
      sessionCookie(STUDENT_COOKIE, record.id, { secure: studentSecure, maxAgeSeconds: STUDENT_SESSION_TTL_MS / 1000 }),
      sessionCookie(STUDENT_CSRF_COOKIE, record.csrf, {
        secure: studentSecure,
        maxAgeSeconds: STUDENT_SESSION_TTL_MS / 1000,
        httpOnly: false,
      }),
    ];
  }

  function clearStudentCookieHeaders() {
    return [
      clearCookie(STUDENT_COOKIE, studentSecure),
      clearCookie(STUDENT_CSRF_COOKIE, studentSecure, false),
    ];
  }

  function getInstructorSession(req) {
    if (!isLoopback(requestIp(req))) return null;
    const id = parseCookies(req)[INSTRUCTOR_COOKIE];
    const record = instructorSessions.get(id);
    if (!record) return null;
    if (record.expiresAt <= now()) {
      instructorSessions.delete(id);
      return null;
    }
    return record;
  }

  function requireStudentMutation(req, record) {
    const submitted = String(req.headers['x-csrf-token'] ?? '');
    const csrfCookie = parseCookies(req)[STUDENT_CSRF_COOKIE];
    if (!record || !hasCanonicalOrigin(req, studentOrigin()) || !equalSecret(submitted, csrfCookie) ||
        !equalSecret(secretHash(submitted), record.csrfHash)) {
      throw new HttpError(403, 'Request origin or CSRF token is invalid');
    }
  }

  function requireInstructor(req, { mutation = false, stream = false } = {}) {
    const origin = instructorOrigin();
    if (!hasCanonicalHost(req, origin)) throw new HttpError(421, 'Misdirected request');
    const record = getInstructorSession(req);
    if (!record) throw new HttpError(401, 'Instructor session is required');
    if (stream && !sameOriginBrowserGet(req, origin)) throw new HttpError(403, 'Request origin is invalid');
    if (mutation && (!hasCanonicalOrigin(req, origin) || !equalSecret(req.headers['x-csrf-token'], record.csrf))) {
      throw new HttpError(403, 'Request origin or CSRF token is invalid');
    }
    return record;
  }

  function stateForInstructor(extra = {}) {
    const origin = studentOrigin();
    return { ...platform.instructorState(), studentUrls: origin ? [origin] : [], ...extra };
  }

  function participantHasLiveActivity(participant) {
    if (!participant || ['completed', 'voided', 'archived'].includes(platform.session?.state)) return false;
    const room = participant.roomId ? platform.rooms.get(participant.roomId) : null;
    return !room || !['completed', 'voided'].includes(room.status);
  }

  function writeStreamPayload(entry, payload) {
    const bytes = Buffer.byteLength(payload);
    if (entry.res.destroyed || entry.res.writableEnded || bytes > SSE_BUFFER_LIMIT || entry.res.writableLength + bytes > SSE_BUFFER_LIMIT) {
      entry.close(true);
      return false;
    }
    if (entry.backpressured) {
      entry.pendingPayload = payload;
      return true;
    }
    if (!entry.res.write(payload)) {
      entry.backpressured = true;
      clearTimeout(entry.stallTimer);
      entry.stallTimer = setTimeout(() => entry.close(true), 10_000);
      entry.res.once('drain', entry.onDrain);
    }
    return true;
  }

  function writeEvent(entry, type, data) {
    return writeStreamPayload(entry, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function writeKeepalive(entry) {
    return entry.backpressured || writeStreamPayload(entry, ': keepalive\n\n');
  }

  function initializeStreamEntry(entry) {
    entry.backpressured = false;
    entry.pendingPayload = null;
    entry.stallTimer = null;
    entry.onDrain = () => {
      if (entry.closed) return;
      entry.backpressured = false;
      clearTimeout(entry.stallTimer);
      entry.stallTimer = null;
      const pending = entry.pendingPayload;
      entry.pendingPayload = null;
      if (pending) writeStreamPayload(entry, pending);
    };
    return entry;
  }

  function openStudentStream(req, res, record) {
    const participant = platform.participants.get(record.participantId);
    if (!participantHasLiveActivity(participant)) {
      throw new HttpError(409, 'Live updates are available only for the active activity');
    }
    if (!streamLimit.take(`student:${record.participantId}`, now())) throw new HttpError(429, 'Live-update connection rate limit exceeded');
    if (studentStreams.size >= 160 && !studentStreams.has(record.participantId)) throw new HttpError(503, 'Live-update capacity reached');
    studentStreams.get(record.participantId)?.close(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const entry = initializeStreamEntry({
      req,
      res,
      record,
      participantId: record.participantId,
      closed: false,
      close(force = false) {
        if (entry.closed) return;
        entry.closed = true;
        clearTimeout(entry.stallTimer);
        res.off('drain', entry.onDrain);
        entry.pendingPayload = null;
        if (studentStreams.get(entry.participantId) === entry) {
          studentStreams.delete(entry.participantId);
          platform.setConnected(entry.participantId, false);
        }
        if (force || entry.backpressured) res.destroy();
        else if (!res.writableEnded) res.end();
      },
    });
    studentStreams.set(record.participantId, entry);
    platform.setConnected(record.participantId, true);
    writeEvent(entry, 'snapshot', platform.studentSnapshot(participant));
    req.on('close', entry.close);
  }

  function openInstructorStream(req, res, record) {
    const key = record.id;
    if (!streamLimit.take(`instructor:${key}`, now())) throw new HttpError(429, 'Live-update connection rate limit exceeded');
    instructorStreams.get(key)?.close(true);
    if (instructorStreams.size >= 4) throw new HttpError(503, 'Instructor live-update capacity reached');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const entry = initializeStreamEntry({
      req,
      res,
      record,
      closed: false,
      close(force = false) {
        if (entry.closed) return;
        entry.closed = true;
        clearTimeout(entry.stallTimer);
        res.off('drain', entry.onDrain);
        entry.pendingPayload = null;
        if (instructorStreams.get(key) === entry) instructorStreams.delete(key);
        if (force || entry.backpressured) res.destroy();
        else if (!res.writableEnded) res.end();
      },
    });
    instructorStreams.set(key, entry);
    writeEvent(entry, 'snapshot', stateForInstructor());
    req.on('close', entry.close);
  }

  function sendStudentSnapshot(participantId, type = 'snapshot') {
    const participant = platform.participants.get(participantId);
    const entry = studentStreams.get(participantId);
    if (participant && entry) {
      writeEvent(entry, type, platform.studentSnapshot(participant));
      if (!participantHasLiveActivity(participant)) entry.close();
    }
  }

  function sendInstructor(type = 'health') {
    const data = stateForInstructor();
    for (const entry of [...instructorStreams.values()]) writeEvent(entry, type, data);
  }

  function scheduleStudent(participantId, type, delay = 80) {
    pendingStudents.set(participantId, type);
    if (studentFlushTimer || closing) return;
    studentFlushTimer = setTimeout(() => {
      studentFlushTimer = null;
      const pending = [...pendingStudents.entries()];
      pendingStudents.clear();
      for (const [id, messageType] of pending) sendStudentSnapshot(id, messageType);
    }, delay);
  }

  function scheduleInstructor(delay = 200) {
    if (instructorFlushTimer || closing) return;
    instructorFlushTimer = setTimeout(() => {
      instructorFlushTimer = null;
      sendInstructor('health');
    }, delay);
  }

  platform.onBroadcast = ({ target, type }) => {
    if (target === 'instructor') scheduleInstructor();
    else if (target === 'all') {
      for (const participant of platform.participants.values()) scheduleStudent(participant.id, type);
    } else scheduleStudent(target, type);
  };

  async function studentHandler(req, res) {
    securityHeaders(res, { secure: studentSecure });
    const origin = studentOrigin();
    let releaseRequest = () => {};
    try {
      releaseRequest = acquireStudentRequest(req);
      if ((req.method === 'GET' || req.method === 'HEAD') && requestHasBody(req)) {
        res.setHeader('Connection', 'close');
        throw new HttpError(400, 'Request body is not allowed for this endpoint');
      }
      await platform.startupRecovery;
      if (!inIpv4Cidr(requestIp(req), allowedStudentCidr)) throw new HttpError(403, 'Client address is outside the classroom subnet');
      if (!hasCanonicalHost(req, origin)) throw new HttpError(421, 'Misdirected request');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/join') {
        if (!hasCanonicalOrigin(req, origin)) throw new HttpError(403, 'Request origin is invalid');
        if (!joinLimit.take(requestAddressKey(req), now()) || !globalJoinLimit.take('all-students', now())) {
          throw new HttpError(429, 'Join rate limit exceeded');
        }
        const body = await readJson(req, 1_024);
        const record = prepareStudentSession();
        const joined = platform.join(body, { webSession: persistedStudentSession(record) });
        const { token: _token, ...publicResult } = joined;
        return json(res, 201, { ...publicResult, csrfToken: record.csrf }, {
          'Set-Cookie': studentCookieHeaders(record),
        });
      }

      let record = getStudentSession(req);
      if (req.method === 'GET' && url.pathname === '/api/me') {
        if (!record) return json(res, 401, { error: 'Student session is required' }, { 'Set-Cookie': clearStudentCookieHeaders() });
        const participant = platform.participants.get(record.participantId);
        const snapshot = participant ? platform.studentSnapshot(participant) : null;
        if (!snapshot) {
          db.revokeStudentWebSession(record.idHash, new Date(now()).toISOString());
          return json(res, 401, { error: 'Student session is no longer valid' }, { 'Set-Cookie': clearStudentCookieHeaders() });
        }
        let csrf = browserCsrf(req, record);
        let refreshedCookies;
        if (!csrf) {
          record = replaceStudentSession(record, record.participantId);
          csrf = record.csrf;
          refreshedCookies = studentCookieHeaders(record);
        }
        return json(res, 200, { ...snapshot, csrfToken: csrf }, refreshedCookies ? { 'Set-Cookie': refreshedCookies } : {});
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!record) throw new HttpError(401, 'Student session is required');
        if (!sameOriginBrowserGet(req, origin)) throw new HttpError(403, 'Request origin is invalid');
        return openStudentStream(req, res, record);
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        requireStudentMutation(req, record);
        const participant = platform.participants.get(record.participantId);
        if (!participant) throw new HttpError(401, 'Student session cannot act in this activity');
        if (!actionIdentityLimit.take(record.participantId, now()) || !actionIpLimit.take(requestAddressKey(req), now())) {
          throw new HttpError(429, 'Action rate limit exceeded');
        }
        const room = participant.roomId ? platform.rooms.get(participant.roomId) : null;
        if (room?.unhealthy) throw new HttpError(409, 'Table is unavailable; instructor review is required');
        const body = await readJson(req, 4_096);
        if (typeof body.actionId !== 'string' || !body.actionId || body.actionId.length > 64 || !body.action ||
            !Number.isInteger(body.actionEpoch) || body.actionEpoch < 0) {
          throw new HttpError(400, 'A short actionId, non-negative actionEpoch, and action are required');
        }
        return json(res, 200, await platform.applyAction(participant, body.actionId, body.action, body.actionEpoch));
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        requireStudentMutation(req, record);
        await readEmptyJson(req);
        db.revokeStudentWebSession(record.idHash, new Date(now()).toISOString());
        studentStreams.get(record.participantId)?.close(true);
        return json(res, 200, { ok: true }, { 'Set-Cookie': clearStudentCookieHeaders() });
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        if (!record) throw new HttpError(401, 'Student session is required');
        if (!exportLimit.take(record.participantId, now())) throw new HttpError(429, 'Export rate limit exceeded');
        const participant = platform.participants.get(record.participantId);
        if (!participant?.roomId) throw new HttpError(409, 'No game data for participant');
        const room = platform.rooms.get(participant.roomId);
        const markdown = platform.exportMarkdown(participant.id);
        const artifact = platform.session?.state === 'voided' || room.status === 'voided' ? 'decision-record' : 'coaching-packet';
        return text(res, 200, markdown, 'text/markdown; charset=utf-8', {
          'Content-Disposition': `attachment; filename="${platform.session.game}-${artifact}.md"`,
        });
      }
      if (req.method === 'GET') {
        const aliases = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
        const file = aliases[url.pathname];
        if (file) return text(res, 200, publicAssets.get(file), contentType(file));
      }
      if (requestHasBody(req)) res.setHeader('Connection', 'close');
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error?.status === 413) res.setHeader('Connection', 'close');
      if (requestHasBody(req) && !req.complete) res.setHeader('Connection', 'close');
      return sendError(res, error, errorLogger);
    } finally {
      releaseRequest();
    }
  }

  async function instructorHandler(req, res) {
    securityHeaders(res);
    const origin = instructorOrigin();
    try {
      if (!instructorRequestLimit.take(requestClientKey(req), now())) throw new HttpError(429, 'Request rate limit exceeded');
      if ((req.method === 'GET' || req.method === 'HEAD') && requestHasBody(req)) {
        res.setHeader('Connection', 'close');
        throw new HttpError(400, 'Request body is not allowed for this endpoint');
      }
      await platform.startupRecovery;
      if (!isLoopback(requestIp(req))) throw new HttpError(403, 'Instructor listener is loopback-only');
      if (!hasCanonicalHost(req, origin)) throw new HttpError(421, 'Misdirected request');
      const url = new URL(req.url, origin);
      const bootstrapMatch = req.method === 'GET' && url.pathname.match(/^\/bootstrap\/([A-Za-z0-9_-]{43})$/);
      if (bootstrapMatch) {
        const candidate = crypto.createHash('sha256').update(bootstrapMatch[1]).digest();
        if (bootstrapUsed || now() > bootstrapExpiresAt || !crypto.timingSafeEqual(candidate, bootstrapHash)) throw new HttpError(401, 'Bootstrap capability is invalid or expired');
        bootstrapUsed = true;
        const id = crypto.randomBytes(32).toString('base64url');
        const record = { id, csrf: crypto.randomBytes(24).toString('base64url'), expiresAt: now() + INSTRUCTOR_SESSION_TTL_MS };
        instructorSessions.set(id, record);
        return redirect(res, '/instructor', { 'Set-Cookie': sessionCookie(INSTRUCTOR_COOKIE, id, { maxAgeSeconds: INSTRUCTOR_SESSION_TTL_MS / 1000 }) });
      }
      if (req.method === 'GET' && url.pathname === '/instructor') {
        const record = requireInstructor(req);
        const template = publicAssets.get('instructor.html').toString('utf8');
        return text(res, 200, template.replace('__CSRF_TOKEN__', record.csrf), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (url.pathname === '/instructor.js' || url.pathname === '/styles.css')) {
        requireInstructor(req);
        const file = url.pathname.slice(1);
        return text(res, 200, publicAssets.get(file), contentType(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/instructor/events') {
        const record = requireInstructor(req, { stream: true });
        return openInstructorStream(req, res, record);
      }
      if (url.pathname.startsWith('/api/instructor/')) {
        const mutation = req.method === 'POST';
        const record = requireInstructor(req, { mutation });
        if (req.method === 'GET' && !sameOriginBrowserGet(req, origin) && !equalSecret(req.headers['x-csrf-token'], record.csrf)) throw new HttpError(403, 'Request origin is invalid');
        if (req.method === 'GET' && url.pathname === '/api/instructor/state') return json(res, 200, stateForInstructor());
        if (req.method === 'POST' && url.pathname === '/api/instructor/session') {
          const created = platform.createSession(await readJson(req, 32_768));
          return json(res, 201, stateForInstructor(created.invitations ? { invitations: created.invitations } : {}));
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/session/start') {
          await readEmptyJson(req);
          return json(res, 200, await platform.startSession());
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/session/pause') {
          await readEmptyJson(req);
          return json(res, 200, await platform.pauseSession());
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/session/resume') {
          await readEmptyJson(req);
          return json(res, 200, await platform.resumeSession());
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/session/end') {
          await readEmptyJson(req);
          return json(res, 200, await platform.endSession());
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/session/void') {
          const body = await readJson(req, 256);
          return json(res, 200, await platform.voidSession(requireOptionalNote(body)));
        }
        if (req.method === 'POST' && url.pathname === '/api/instructor/purge') {
          const body = await readJson(req, 128);
          if (Object.keys(body).length !== 1 || body.confirmation !== 'PURGE ARCHIVED DATA') {
            throw new HttpError(400, 'Exact purge confirmation is required');
          }
          const result = platform.purgeExpiredData();
          return json(res, 200, stateForInstructor({ purge: result }));
        }
        let rosterMatch = url.pathname.match(/^\/api\/instructor\/roster\/([^/]+)\/(rotate|revoke)$/);
        if (req.method === 'POST' && rosterMatch) {
          await readEmptyJson(req);
          if (rosterMatch[2] === 'rotate') {
            const invitation = platform.rotateRosterInvitation(rosterMatch[1]);
            return json(res, 200, stateForInstructor({ invitations: [invitation] }));
          }
          const revoked = platform.instructorState().roster.find((entry) => entry.id === rosterMatch[1]);
          platform.revokeRosterInvitation(rosterMatch[1]);
          return json(res, 200, stateForInstructor({ revokedInvitationIdentity: revoked?.identity ?? null }));
        }
        let match = url.pathname.match(/^\/api\/instructor\/room\/([^/]+)\/void$/);
        if (req.method === 'POST' && match) {
          const body = await readJson(req, 256);
          return json(res, 200, await platform.voidRoom(match[1], requireOptionalNote(body)));
        }
        match = url.pathname.match(/^\/api\/instructor\/participant\/([^/]+)\/(remove|replace|restore)$/);
        if (req.method === 'POST' && match) {
          await readEmptyJson(req);
          if (match[2] === 'remove') {
            const state = platform.removeParticipant(match[1]);
            studentStreams.get(match[1])?.close(true);
            return json(res, 200, state);
          }
          return json(res, 200, await platform.replaceWithBot(match[1], match[2] === 'replace'));
        }
        match = url.pathname.match(/^\/api\/instructor\/export\/([^/]+)$/);
        if (req.method === 'GET' && match) {
          const markdown = platform.exportMarkdown(match[1]);
          const participant = platform.participants.get(match[1]);
          const room = participant?.roomId ? platform.rooms.get(participant.roomId) : null;
          const artifact = platform.session?.state === 'voided' || room?.status === 'voided' ? 'decision-record' : 'coaching-packet';
          return text(res, 200, markdown, 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="student-${artifact}.md"` });
        }
        if (req.method === 'GET' && ['/api/instructor/audit-export', '/api/instructor/audit-export.json'].includes(url.pathname)) {
          const current = platform.instructorState();
          if (!['completed', 'voided'].includes(current.session?.state)) {
            throw new HttpError(409, 'Instructor audit is available only after the activity is completed or voided');
          }
          if (url.pathname.endsWith('.json')) {
            return json(res, 200, platform.classAudit(), { 'Content-Disposition': 'attachment; filename="instructor-audit.json"' });
          }
          return text(res, 200, platform.classExportMarkdown(), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="instructor-audit.md"' });
        }
        if (requestHasBody(req)) res.setHeader('Connection', 'close');
        return json(res, 404, { error: 'Instructor endpoint not found' });
      }
      if (requestHasBody(req)) res.setHeader('Connection', 'close');
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error?.status === 413) res.setHeader('Connection', 'close');
      if (requestHasBody(req) && !req.complete) res.setHeader('Connection', 'close');
      return sendError(res, error, errorLogger);
    }
  }

  studentServer = tls
    ? https.createServer({ ...tls, minVersion: tls.minVersion ?? 'TLSv1.2', handshakeTimeout: 5_000, maxHeaderSize: 8 * 1024 }, studentHandler)
    : http.createServer({ maxHeaderSize: 8 * 1024 }, studentHandler);
  instructorServer = http.createServer({ maxHeaderSize: 8 * 1024 }, instructorHandler);
  configureServer(studentServer, 256);
  configureServer(instructorServer, 16);
  capConnectionsPerIp(studentServer, 32);
  capConnectionsPerIp(instructorServer, 8);
  restrictListenHost(studentServer, studentHost, 'Student listener');
  restrictListenHost(instructorServer, '127.0.0.1', 'Instructor listener');
  const rejectUpgrade = (_req, socket) => {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  };
  studentServer.on('upgrade', rejectUpgrade);
  instructorServer.on('upgrade', rejectUpgrade);

  const maintenanceTimer = setInterval(() => {
    const currentTime = now();
    db.purgeExpiredWebSessions(new Date(currentTime).toISOString());
    for (const [id, record] of instructorSessions) if (record.expiresAt <= currentTime) instructorSessions.delete(id);
    for (const entry of [...studentStreams.values()]) {
      if (!db.studentWebSession(entry.record.idHash, new Date(currentTime).toISOString()) || !writeKeepalive(entry)) entry.close(true);
    }
    for (const entry of [...instructorStreams.values()]) {
      if (!instructorSessions.has(entry.record.id) || !writeKeepalive(entry)) entry.close(true);
    }
  }, 15_000);
  maintenanceTimer.unref?.();

  async function close() {
    closing = true;
    clearTimeout(studentFlushTimer);
    clearTimeout(instructorFlushTimer);
    clearInterval(maintenanceTimer);
    pendingStudents.clear();
    platform.close();
    await platform.startupRecovery.catch(() => {});
    for (const entry of [...studentStreams.values()]) entry.close(true);
    for (const entry of [...instructorStreams.values()]) entry.close(true);
    await Promise.all([
      studentServer.listening ? new Promise((resolve) => studentServer.close(resolve)) : Promise.resolve(),
      instructorServer.listening ? new Promise((resolve) => instructorServer.close(resolve)) : Promise.resolve(),
    ]);
    db.close();
  }

  function instructorBootstrapUrl() {
    const origin = instructorOrigin();
    if (!origin) throw new Error('Instructor listener must be listening before its bootstrap URL is requested');
    return `${origin}/bootstrap/${bootstrapToken}`;
  }

  return {
    server: studentServer,
    studentServer,
    instructorServer,
    platform,
    db,
    close,
    instructorBootstrapToken: bootstrapToken,
    instructorBootstrapUrl,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const studentPort = Number(process.env.PORT ?? 3000);
  const instructorPort = Number(process.env.INSTRUCTOR_PORT ?? studentPort + 1);
  const studentHost = process.env.STUDENT_HOST ?? '127.0.0.1';
  const tls = process.env.TLS_KEY_PATH && process.env.TLS_CERT_PATH ? {
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
  } : null;
  const app = createApplication({
    studentHost,
    studentPublicOrigin: process.env.STUDENT_PUBLIC_ORIGIN ?? null,
    studentAllowedCidr: process.env.STUDENT_ALLOWED_CIDR ?? null,
    tls,
    encryptionKey: process.env.AGENTIC_DATA_KEY ?? null,
  });
  await Promise.all([
    new Promise((resolve) => app.studentServer.listen(studentPort, studentHost, resolve)),
    new Promise((resolve) => app.instructorServer.listen(instructorPort, '127.0.0.1', resolve)),
  ]);
  console.log(`Instructor: ${app.instructorBootstrapUrl()}`);
  const studentAddress = app.studentServer.address();
  const fallbackOrigin = `${tls ? 'https' : 'http'}://${authority(studentHost, studentAddress.port)}`;
  console.log(`Students:   ${process.env.STUDENT_PUBLIC_ORIGIN ?? fallbackOrigin}/`);
  console.log('Leave this terminal running during class.');
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
