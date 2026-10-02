import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEATING_TOPOLOGY_VERSION = 'seating-v3';
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
const SEATING_TOPOLOGY = Object.freeze({
  rps: { liveTableSize: 2, botSeats: 2 },
  liars_dice: { liveTableSize: 5, botSeats: 5 },
  blackjack: { liveTableSize: 5, botSeats: 3 },
  poker: { liveTableSize: 5, botSeats: 3 },
  trading: { liveTableSize: 15, botSeats: 6 },
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const filename = args[0];
  const keyIndex = args.indexOf('--public-key');
  const publicKeyFile = keyIndex >= 0 ? args[keyIndex + 1] : null;
  const validArguments = filename && keyIndex === 1 && publicKeyFile && args.length === 3;
  if (!validArguments) {
    console.error('Usage: npm run verify:audit -- instructor-audit.json --public-key trusted-audit-public-key.pem');
    process.exitCode = 2;
  } else {
    try {
      const audit = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const summary = verifyAudit(audit, { trustedPublicKey: fs.readFileSync(publicKeyFile) });
      console.log(`Verified ${summary.events} events, ${summary.rooms} rooms, root ${summary.root}, signing key ${summary.keyFingerprint}`);
    } catch (error) {
      console.error(`Audit verification failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

export function verifyAudit(audit, { trustedPublicKey } = {}) {
  requireCondition(trustedPublicKey != null, 'A separately trusted audit public key is required');
  requireCondition(audit?.format === 'agentic-games-instructor-audit-v2', 'Unsupported audit format');
  requireCondition(['completed', 'voided'].includes(audit?.session?.state), 'Audit session is not terminal');
  requireCondition(Object.hasOwn(SEATING_TOPOLOGY, audit?.session?.game), 'Audit session has an unknown game');
  requireCondition(['random', 'strategy', 'live'].includes(audit?.session?.mode), 'Audit session has an unknown mode');
  requireCondition(typeof audit?.session?.id === 'string' && audit.session.id, 'Audit session id is invalid');
  requireCondition(audit.session.config && typeof audit.session.config === 'object' && !Array.isArray(audit.session.config),
    'Audit session configuration is invalid');
  requireCondition(audit.session.config.auditTopologyVersion === SEATING_TOPOLOGY_VERSION,
    `Audit session does not declare ${SEATING_TOPOLOGY_VERSION}`);
  requireCondition(Array.isArray(audit.events), 'Audit events are missing');
  requireCondition(Array.isArray(audit.rooms), 'Audit rooms are missing');
  requireCondition(Array.isArray(audit.roster), 'Audit roster is missing');
  requireCondition(Array.isArray(audit.controllerTransitions), 'Controller transitions are missing');
  requireCondition(Array.isArray(audit.resultProvenance), 'Result provenance is missing');
  requireCondition(audit.eventChain?.algorithm === 'sha256-canonical-json-v1', 'Unexpected event-chain algorithm');
  requireCondition(audit.eventChain?.genesis === '0'.repeat(64), 'Unexpected event-chain genesis');

  let previousHash = audit.eventChain.genesis;
  let previousId = 0;
  const lastRoomHash = new Map();
  const eventsByRoom = new Map();
  for (const event of audit.events) {
    requireCondition(Number.isInteger(event.id) && event.id > previousId, 'Events are not in strict database order');
    const sessionScoped = SESSION_EVENT_TYPES.has(event.type);
    const roomScoped = ROOM_EVENT_TYPES.has(event.type);
    requireCondition(sessionScoped !== roomScoped, `Event ${event.id} has an unsupported event type`);
    if (sessionScoped) {
      requireCondition(event.roomId === null && event.sequence === null,
        `Session event ${event.id} must have null room and sequence`);
    } else {
      requireCondition(typeof event.roomId === 'string' && event.roomId.trim() === event.roomId && event.roomId,
        `Room event ${event.id} has an invalid room id`);
      requireCondition(Number.isSafeInteger(event.sequence) && event.sequence > 0,
        `Room event ${event.id} has an invalid sequence`);
    }
    requireCondition(event.previousHash === previousHash, `Event ${event.id} has the wrong previous hash`);
    const canonical = canonicalJson({
      actor_id: event.actorId ?? null,
      created_at: event.createdAt,
      payload: event.payload,
      room_id: event.roomId ?? null,
      sequence: event.sequence ?? null,
      session_id: audit.session.id,
      type: event.type,
      visibility: event.visibility,
    });
    const expected = crypto.createHash('sha256').update(previousHash).update('\n').update(canonical).digest('hex');
    requireCondition(event.eventHash === expected, `Event ${event.id} hash does not verify`);
    previousHash = expected;
    previousId = event.id;
    if (roomScoped) {
      lastRoomHash.set(event.roomId, event.eventHash);
      if (!eventsByRoom.has(event.roomId)) eventsByRoom.set(event.roomId, []);
      eventsByRoom.get(event.roomId).push(event);
    }
  }
  requireCondition(audit.eventChain.count === audit.events.length, 'Event count does not match the transcript');
  requireCondition(audit.eventChain.root === previousHash, 'Terminal event root does not match the transcript');
  requireCondition(audit.eventChain.verified === true, 'Exporter reported a broken event chain');

  const rooms = new Map();
  const playerRoom = new Map();
  const decisionIds = new Set();
  for (const room of audit.rooms) {
    requireCondition(!rooms.has(room.id), `Duplicate room ${room.id}`);
    requireCondition(room.game === audit.session.game, `Room ${room.id} game does not match the session`);
    requireCondition(room.mode === audit.session.mode, `Room ${room.id} mode does not match the session`);
    requireCondition(['completed', 'voided'].includes(room.status), `Room ${room.id} is not terminal`);
    requireCondition(Array.isArray(room.players) && room.players.length > 0, `Room ${room.id} players are missing`);
    requireCondition(Array.isArray(room.decisions), `Room ${room.id} decisions are missing`);
    requireCondition(Number.isInteger(room.rngCounter) && room.rngCounter >= 0, `Room ${room.id} RNG counter is invalid`);
    requireCondition(/^[a-f0-9]{64}$/.test(room.seed), `Room ${room.id} seed is invalid`);
    const commitment = crypto.createHash('sha256').update(Buffer.from(room.seed, 'hex')).digest('hex');
    requireCondition(room.seedCommitment === commitment, `Room ${room.id} seed commitment does not verify`);
    requireCondition(room.transcriptRoot === lastRoomHash.get(room.id), `Room ${room.id} transcript root does not match`);
    for (const player of room.players) {
      requireCondition(typeof player.id === 'string' && player.id, `Room ${room.id} has an invalid player`);
      requireCondition(!playerRoom.has(player.id), `Player ${player.id} appears in more than one room`);
      requireCondition(['student', 'server'].includes(player.accountKind), `Player ${player.id} has an invalid account kind`);
      if (player.accountKind === 'student') {
        requireCondition(typeof player.rosterIdentity === 'string' && player.rosterIdentity,
          `Student ${player.id} is missing its roster identity binding`);
      }
      playerRoom.set(player.id, room.id);
    }
    for (const decision of room.decisions) {
      requireCondition(Number.isInteger(decision.id) && decision.id > 0, `Room ${room.id} has an invalid decision id`);
      requireCondition(!decisionIds.has(decision.id), `Duplicate decision ${decision.id}`);
      requireCondition(room.players.some((player) => player.id === decision.playerId),
        `Decision ${decision.id} references unknown player ${decision.playerId}`);
      decisionIds.add(decision.id);
    }
    rooms.set(room.id, room);
  }

  verifyTopology(audit, rooms, eventsByRoom, playerRoom);
  verifyDecisionCoverage(rooms, eventsByRoom);
  verifyControllerCoverage(audit.controllerTransitions, rooms, audit.events);

  const provenanceKeys = new Set();
  for (const result of audit.resultProvenance) {
    const room = rooms.get(result.roomId);
    requireCondition(room, `Result references unknown room ${result.roomId}`);
    requireCondition(room.players.some((player) => player.id === result.playerId),
      `Result references unknown player ${result.playerId}`);
    requireCondition(result.transcriptRoot === room.transcriptRoot, `Result for ${result.playerId} has the wrong transcript root`);
    const key = `${result.roomId}\0${result.playerId}`;
    requireCondition(!provenanceKeys.has(key), `Duplicate result provenance for ${result.playerId}`);
    provenanceKeys.add(key);
  }
  for (const room of rooms.values()) {
    for (const player of room.players ?? []) {
      requireCondition(provenanceKeys.has(`${room.id}\0${player.id}`), `Room ${room.id} is missing result provenance for ${player.id}`);
    }
  }

  const roomSeals = [];
  for (const room of rooms.values()) {
    const roomEvents = eventsByRoom.get(room.id) ?? [];
    const expectedDisposition = room.status === 'completed' ? 'room_completed' : 'room_voided';
    const dispositions = roomEvents.filter((event) => ['room_completed', 'room_voided'].includes(event.type));
    requireCondition(dispositions.length === 1 && dispositions[0].type === expectedDisposition,
      `Room ${room.id} must have exactly one ${expectedDisposition} disposition event`);
    const seals = roomEvents.filter((event) => event.type === 'room_audit_sealed');
    requireCondition(seals.length === 1, `Room ${room.id} must have exactly one audit seal`);
    const seal = seals[0];
    requireCondition(roomEvents.at(-2) === dispositions[0] && roomEvents.at(-1) === seal,
      `Room ${room.id} disposition and audit seal must be its final two events`);
    requireCondition(seal.eventHash === room.transcriptRoot,
      `Room ${room.id} audit seal must be its transcript root`);
    requireCondition(seal.payload?.algorithm === 'sha256-canonical-json-v1', `Room ${room.id} uses an unknown seal algorithm`);
    const results = audit.resultProvenance.filter((entry) => entry.roomId === room.id).map((entry) => ({
      playerId: entry.playerId,
      controllerSummary: entry.controllerSummary,
      competitiveEligible: entry.competitiveEligible,
      result: entry.result,
      createdAt: entry.createdAt,
    })).sort((left, right) => left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0);
    const bundle = {
      room: {
        id: room.id, status: room.status, game: room.game, mode: room.mode,
        seed: room.seed, seedCommitment: room.seedCommitment, rngCounter: room.rngCounter,
        players: room.players, finalState: room.finalState,
      },
      decisions: room.decisions,
      controllerTransitions: audit.controllerTransitions.filter((entry) => entry.roomId === room.id),
      results,
    };
    const bundleHash = crypto.createHash('sha256').update(canonicalJson(bundle)).digest('hex');
    requireCondition(seal.payload?.bundleHash === bundleHash, `Room ${room.id} audit bundle was altered`);
    roomSeals.push({ roomId: room.id, status: room.status, bundleHash, transcriptRoot: room.transcriptRoot });
  }

  roomSeals.sort((left, right) => left.roomId < right.roomId ? -1 : left.roomId > right.roomId ? 1 : 0);
  const sessionSeals = audit.events.filter((event) => event.roomId == null && event.type === 'session_audit_sealed');
  requireCondition(sessionSeals.length === 1, 'Session must have exactly one audit seal');
  const sessionSeal = sessionSeals[0];
  requireCondition(sessionSeal.eventHash === audit.eventChain.root, 'Session audit seal must be the final event');
  const expectedSessionDisposition = audit.session.state === 'completed' ? 'session_completed' : 'session_voided';
  const sessionDisposition = audit.events.find((event) => event.roomId == null && event.type === expectedSessionDisposition);
  const dispositionIndex = audit.events.indexOf(sessionDisposition);
  const sessionSealIndex = audit.events.indexOf(sessionSeal);
  requireCondition(dispositionIndex === sessionSealIndex - 1,
    'Session disposition must immediately precede the final session audit seal');
  requireCondition(roomSeals.every(({ roomId }) => {
    const roomSeal = eventsByRoom.get(roomId)?.find((event) => event.type === 'room_audit_sealed');
    return roomSeal && audit.events.indexOf(roomSeal) < dispositionIndex;
  }), 'Every room audit seal must precede the session disposition');
  requireCondition(sessionSeal.payload?.algorithm === 'sha256-canonical-json-v1', 'Session uses an unknown seal algorithm');
  const sessionMaterial = {
    session: audit.session,
    roster: audit.roster,
    controllerTransitions: audit.controllerTransitions,
    roomSeals,
    effectiveResults: audit.resultProvenance.map((entry) => ({
      roomId: entry.roomId,
      playerId: entry.playerId,
      sealedCompetitiveEligible: entry.competitiveEligible,
      effectiveCompetitiveEligible: entry.effectiveCompetitiveEligible,
    })),
  };
  const auditHash = crypto.createHash('sha256').update(canonicalJson(sessionMaterial)).digest('hex');
  requireCondition(sessionSeal.payload?.auditHash === auditHash, 'Session audit material was altered');

  const publicKey = parseTrustedPublicKey(trustedPublicKey);
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyFingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  requireCondition(audit.authenticity?.algorithm === 'ed25519-v1', 'Unsupported audit-root signature algorithm');
  requireCondition(audit.authenticity?.publicKey === publicKeyDer.toString('base64url'),
    'Audit was signed by a different public key than the trusted key');
  requireCondition(audit.authenticity?.keyFingerprint === keyFingerprint, 'Audit signing-key fingerprint does not match');
  requireCondition(audit.authenticity?.signedRoot === audit.eventChain.root, 'Audit signature references the wrong root');
  const signature = Buffer.from(String(audit.authenticity?.signature ?? ''), 'base64url');
  requireCondition(signature.length === 64, 'Audit signature is malformed');
  const message = Buffer.from(`agentic-trading-games:audit-root-signature:v1\0${audit.session.id}\0${audit.eventChain.root}`, 'utf8');
  requireCondition(crypto.verify(null, message, publicKey, signature), 'Audit-root signature does not verify');

  return { events: audit.events.length, rooms: rooms.size, root: previousHash, keyFingerprint };
}

function verifyTopology(audit, rooms, eventsByRoom, playerRoom) {
  for (const roomId of eventsByRoom.keys()) {
    requireCondition(rooms.has(roomId), `Transcript references unexported room ${roomId}`);
  }
  for (const [roomId, events] of eventsByRoom) {
    for (let index = 0; index < events.length; index += 1) {
      requireCondition(events[index].sequence === index + 1, `Room ${roomId} event sequence is not contiguous`);
    }
  }

  const created = audit.events.filter((event) => event.type === 'session_created');
  requireCondition(created.length === 1, 'Session must have exactly one creation event');
  requireCondition(created[0].roomId == null, 'Session creation event cannot belong to a room');
  const creationConfig = created[0].payload?.config;
  const currentConfig = audit.session.config;
  const stableConfig = (config) => Object.fromEntries(Object.entries(config ?? {})
    .filter(([key]) => !['rulesVersion', 'botVersion'].includes(key)));
  requireCondition(created[0].payload?.game === audit.session.game && created[0].payload?.mode === audit.session.mode &&
    canonicalEqual(stableConfig(creationConfig), stableConfig(currentConfig)),
  'Session creation event does not match session metadata');
  if (!canonicalEqual(creationConfig, currentConfig)) {
    const quarantines = audit.events.filter((event) => event.type === 'session_version_quarantined' &&
      event.payload?.storedRules === currentConfig?.rulesVersion && event.payload?.storedBots === currentConfig?.botVersion);
    requireCondition(quarantines.length === 1, 'Session version metadata changed without one quarantine event');
  }

  const terminalType = audit.session.state === 'completed' ? 'session_completed' : 'session_voided';
  const terminalEvents = audit.events.filter((event) => ['session_completed', 'session_voided'].includes(event.type));
  requireCondition(terminalEvents.length === 1 && terminalEvents[0].type === terminalType,
    `Session must have exactly one ${terminalType} disposition event`);

  const roomCreated = new Map();
  for (const [roomId, events] of eventsByRoom) {
    const matches = events.filter((event) => event.type === 'room_created');
    requireCondition(matches.length === 1, `Room ${roomId} must have exactly one creation event`);
    const event = matches[0];
    const room = rooms.get(roomId);
    const expectedPlayers = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isBot: player.accountKind === 'server',
      botKind: player.accountKind === 'server' ? player.botKind : null,
    }));
    requireCondition(canonicalEqual(event.payload?.players, expectedPlayers),
      `Room ${roomId} creation players do not match the exported room`);
    requireCondition(event.payload?.seedCommitment === room.seedCommitment,
      `Room ${roomId} creation commitment does not match`);
    requireCondition(event.payload?.generatorVersion === 'sha256-counter-v1',
      `Room ${roomId} uses an unknown random generator`);
    requireCondition(event.payload?.topologyVersion === SEATING_TOPOLOGY_VERSION,
      `Room ${roomId} uses an unknown seating topology`);
    roomCreated.set(roomId, event);
  }

  const commitments = audit.events.filter((event) => event.type === 'seating_draw_committed');
  const reveals = audit.events.filter((event) => event.type === 'seating_draw_revealed');
  const starts = audit.events.filter((event) => event.type === 'session_started');
  if (!rooms.size) {
    requireCondition(commitments.length === 0 && reveals.length === 0 && starts.length === 0,
      'An unseated session cannot contain seating or start events');
  } else {
    requireCondition(commitments.length === 1 && reveals.length === 1, 'Session must have exactly one seating commitment/reveal pair');
    requireCondition(starts.length === 1, 'Started session must have exactly one start event');
    const commitmentEvent = commitments[0];
    const revealEvent = reveals[0];
    requireCondition(commitmentEvent.payload?.topologyVersion === SEATING_TOPOLOGY_VERSION &&
      revealEvent.payload?.topologyVersion === SEATING_TOPOLOGY_VERSION,
    'Seating proof uses an unknown topology version');
    const creationEvents = [...roomCreated.values()];
    requireCondition(commitmentEvent.id < Math.min(...creationEvents.map((event) => event.id)) &&
      revealEvent.id > Math.max(...creationEvents.map((event) => event.id)) && revealEvent.id < starts[0].id,
    'Seating commitment, room creation, reveal, and start events are out of order');
    requireCondition(/^[a-f0-9]{64}$/.test(revealEvent.payload?.seed), 'Seating reveal seed is invalid');
    const commitment = crypto.createHash('sha256').update(Buffer.from(revealEvent.payload.seed, 'hex')).digest('hex');
    requireCondition(commitmentEvent.payload?.commitment === commitment, 'Seating commitment does not verify');
    requireCondition(Array.isArray(revealEvent.payload?.order), 'Seating reveal order is missing');
    requireCondition(Array.isArray(revealEvent.payload?.rooms), 'Seating reveal rooms are missing');
    requireCondition(commitmentEvent.payload?.participantCount === revealEvent.payload.order.length,
      'Seating participant count does not match the reveal');
    requireUniqueStrings(revealEvent.payload.order, 'Seating reveal contains a duplicate student');
    const studentIds = [...playerRoom.entries()].filter(([playerId, roomId]) =>
      rooms.get(roomId).players.find((player) => player.id === playerId)?.accountKind === 'student').map(([playerId]) => playerId);
    requireCondition(equalStringSets(revealEvent.payload.order, studentIds), 'Seating reveal does not cover the student roster');
    const activeAtLock = new Map();
    for (const event of audit.events) {
      if (event.id >= commitmentEvent.id) break;
      if (event.type === 'participant_joined') activeAtLock.set(event.payload?.participantId, event);
      if (event.type === 'participant_removed') activeAtLock.delete(event.payload?.participantId);
    }
    const expectedOrder = shuffleWithAuditSeed([...activeAtLock.keys()], revealEvent.payload.seed);
    requireCondition(canonicalEqual(revealEvent.payload.order, expectedOrder),
      'Seating reveal order does not match the committed shuffle');

    verifySeatingTopology(audit.session, rooms, revealEvent.payload.rooms, expectedOrder,
      audit.events.filter((event) => event.type === 'room_created').map((event) => event.roomId));

    const revealedRooms = new Map();
    for (const revealed of revealEvent.payload.rooms) {
      requireCondition(revealed && typeof revealed.id === 'string' && Array.isArray(revealed.players),
        'Seating reveal contains an invalid room');
      requireCondition(!revealedRooms.has(revealed.id), `Seating reveal duplicates room ${revealed.id}`);
      requireUniqueStrings(revealed.players, `Seating reveal duplicates a player in room ${revealed.id}`);
      revealedRooms.set(revealed.id, revealed.players);
    }
    requireCondition(revealedRooms.size === rooms.size, 'Seating reveal room count does not match the audit');
    for (const room of rooms.values()) {
      requireCondition(canonicalEqual(revealedRooms.get(room.id), room.players.map((player) => player.id)),
        `Seating reveal does not match room ${room.id}`);
    }
    requireCondition(starts[0].payload?.roomCount === rooms.size, 'Session start room count does not match the audit');
  }

  const rosterIdentities = new Set();
  const rosterByIdentity = new Map();
  const rosterParticipants = new Map();
  const joinedParticipants = new Map();
  const removedParticipants = new Map();
  for (const event of audit.events) {
    if (event.type === 'participant_joined') {
      const participantId = event.payload?.participantId;
      requireCondition(typeof participantId === 'string' && participantId && event.actorId === participantId,
        'Participant join event has an invalid identity');
      requireCondition(!joinedParticipants.has(participantId), `Participant ${participantId} joined more than once`);
      joinedParticipants.set(participantId, event);
    } else if (event.type === 'participant_removed') {
      const participantId = event.payload?.participantId;
      requireCondition(joinedParticipants.has(participantId), `Participant ${participantId} was removed before joining`);
      requireCondition(!removedParticipants.has(participantId), `Participant ${participantId} was removed more than once`);
      removedParticipants.set(participantId, event);
    }
  }
  for (const entry of audit.roster) {
    requireCondition(typeof entry.identity === 'string' && entry.identity, 'Roster contains an invalid identity');
    requireCondition(!rosterIdentities.has(entry.identity), `Roster contains duplicate identity ${entry.identity}`);
    rosterIdentities.add(entry.identity);
    rosterByIdentity.set(entry.identity, entry);
    if (entry.participantId != null) {
      requireCondition(typeof entry.participantId === 'string' && entry.participantId, 'Roster contains an invalid participant link');
      requireCondition(!rosterParticipants.has(entry.participantId), `Roster links participant ${entry.participantId} more than once`);
      rosterParticipants.set(entry.participantId, entry);
    }
  }
  for (const room of rooms.values()) {
    for (const player of room.players.filter((entry) => entry.accountKind === 'student')) {
      const roster = rosterParticipants.get(player.id);
      requireCondition(roster, `Student ${player.id} is missing from the roster`);
      requireCondition(joinedParticipants.has(player.id), `Student ${player.id} has no admission event`);
      requireCondition(rosterByIdentity.get(player.rosterIdentity) === roster,
        `Student ${player.id} does not match its roster identity`);
      requireCondition(roster.name === player.name, `Roster identity for ${player.id} does not match the seated student`);
    }
  }
  for (const [participantId, roster] of rosterParticipants) {
    const joined = joinedParticipants.get(participantId);
    requireCondition(joined, `Roster participant ${participantId} has no admission event`);
    requireCondition(joined.payload?.name === roster.name, `Admission for ${participantId} does not match the roster name`);
    const cancelledBeforeSeating = rooms.size === 0 && audit.session.state === 'voided' && starts.length === 0;
    requireCondition(playerRoom.has(participantId) || removedParticipants.has(participantId) || cancelledBeforeSeating,
      `Roster participant ${participantId} is neither seated, removed, nor part of a cancelled lobby`);
  }
  for (const participantId of joinedParticipants.keys()) {
    requireCondition(rosterParticipants.has(participantId) || removedParticipants.has(participantId),
      `Admission ${participantId} has no current roster link or removal event`);
  }
}

function verifySeatingTopology(session, rooms, revealedRooms, studentOrder, roomCreationOrder) {
  const topology = SEATING_TOPOLOGY[session.game];
  requireCondition(topology, `No seating topology is defined for ${session.game}`);
  requireCondition(revealedRooms.every((room) => room && typeof room.id === 'string' && Array.isArray(room.players)),
    'Seating reveal contains an invalid room');
  const humanTableSize = session.mode === 'live'
    ? session.game === 'trading' ? topology.liveTableSize - 1 : topology.liveTableSize
    : 1;
  const humanGroups = [];
  for (let index = 0; index < studentOrder.length; index += humanTableSize) {
    humanGroups.push(studentOrder.slice(index, index + humanTableSize));
  }
  requireCondition(revealedRooms.length === humanGroups.length, 'Seating topology produced the wrong number of rooms');
  requireCondition(canonicalEqual(revealedRooms.map((room) => room.id), roomCreationOrder),
    'Seating reveal room order does not match room creation order');

  for (let index = 0; index < humanGroups.length; index += 1) {
    const revealed = revealedRooms[index];
    const room = rooms.get(revealed.id);
    requireCondition(room, `Seating topology references unknown room ${revealed.id}`);
    const humanIds = humanGroups[index];
    requireCondition(canonicalEqual(room.players.slice(0, humanIds.length).map((player) => player.id), humanIds),
      `Room ${room.id} student grouping does not match the shuffled order`);
    requireCondition(room.players.slice(0, humanIds.length).every((player) => player.accountKind === 'student'),
      `Room ${room.id} has a server seat inside the student group`);
    requireCondition(room.players.filter((player) => player.accountKind === 'student').length === humanIds.length,
      `Room ${room.id} has an unexpected student seat`);

    const targetSize = session.mode === 'live'
      ? session.game === 'trading' ? humanIds.length + 1 : topology.liveTableSize
      : topology.botSeats;
    requireCondition(room.players.length === targetSize, `Room ${room.id} has the wrong number of seats`);
    const serverSeats = room.players.slice(humanIds.length);
    const expectedBotKind = session.mode === 'strategy' ? 'strategy'
      : session.mode === 'live' && session.game === 'trading' ? 'market_maker'
      : 'random';
    requireCondition(serverSeats.every((player) => player.accountKind === 'server' && player.isBot === true &&
      player.botKind === expectedBotKind && player.controller === 'bot' && player.competitiveEligible === false),
    `Room ${room.id} server-seat policy does not match ${SEATING_TOPOLOGY_VERSION}`);
    if (session.mode === 'live' && session.game === 'trading') {
      requireCondition(serverSeats.length === 1, `Room ${room.id} must have exactly one market maker`);
    }
  }
}

function verifyDecisionCoverage(rooms, eventsByRoom) {
  for (const room of rooms.values()) {
    const decisions = [...room.decisions].sort((left, right) => left.id - right.id);
    for (let index = 1; index < decisions.length; index += 1) {
      requireCondition(decisions[index - 1].id < decisions[index].id, `Room ${room.id} decisions are not in strict order`);
    }
    const accepted = decisions.filter((decision) => decision.outcome?.type !== 'rejected_action' && decision.outcome?.type !== 'timeout_action');
    const rejected = decisions.filter((decision) => decision.outcome?.type === 'rejected_action');
    const timedOut = decisions.filter((decision) => decision.outcome?.type === 'timeout_action');
    const events = eventsByRoom.get(room.id);
    reconcileDecisionEvents(room.id, events.filter((event) => event.type === 'student_action'), accepted,
      (event, decision) => event.actorId === decision.playerId && canonicalEqual(event.payload?.action, decision.action) &&
        canonicalEqual(event.payload?.result?.resolution ?? event.payload?.result, decision.outcome), 'accepted');
    reconcileDecisionEvents(room.id, events.filter((event) => event.type === 'student_action_rejected'), rejected,
      (event, decision) => event.actorId === decision.playerId && canonicalEqual(event.payload?.action, decision.action) &&
        canonicalEqual({ type: 'rejected_action', actionId: event.payload?.actionId, code: event.payload?.code }, decision.outcome),
    'rejected');
    reconcileDecisionEvents(room.id, events.filter((event) => event.type === 'student_action_timeout'), timedOut,
      (event, decision) => event.payload?.participantId === decision.playerId && canonicalEqual(event.payload?.action, decision.action) &&
        canonicalEqual({ type: 'timeout_action', result: event.payload?.result }, decision.outcome), 'timeout');
  }
}

function reconcileDecisionEvents(roomId, events, decisions, matches, label) {
  requireCondition(events.length === decisions.length,
    `Room ${roomId} ${label} action/decision count does not match`);
  for (let index = 0; index < events.length; index += 1) {
    requireCondition(matches(events[index], decisions[index]),
      `Room ${roomId} ${label} action event does not match decision ${decisions[index]?.id ?? 'missing'}`);
  }
}

function verifyControllerCoverage(transitions, rooms, events) {
  const expected = [];
  for (const event of events) {
    if (event.type === 'student_action_timeout') {
      expected.push({ roomId: event.roomId, playerId: event.payload?.participantId, controller: 'system',
        reason: 'decision_timeout', actorId: 'system', sequence: event.sequence });
    } else if (event.type === 'participant_replaced_by_bot') {
      expected.push({ roomId: event.roomId, playerId: event.payload?.participantId, controller: 'bot',
        reason: 'instructor_takeover', actorId: 'instructor', sequence: event.sequence });
    } else if (event.type === 'participant_restored') {
      expected.push({ roomId: event.roomId, playerId: event.payload?.participantId, controller: 'authenticated_student',
        reason: 'instructor_restore', actorId: 'instructor', sequence: event.sequence });
    }
  }
  requireCondition(transitions.length === expected.length, 'Controller transition count does not match the transcript');
  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    const room = rooms.get(transition.roomId);
    requireCondition(room, `Controller transition references unknown room ${transition.roomId}`);
    requireCondition(room.players.some((player) => player.id === transition.playerId),
      `Controller transition references unknown player ${transition.playerId}`);
    const match = expected[index];
    requireCondition(transition.roomId === match.roomId && transition.playerId === match.playerId &&
      transition.controller === match.controller && transition.reason === match.reason &&
      transition.actorId === match.actorId && transition.sequence === match.sequence,
    `Controller transition ${index + 1} does not match the transcript`);
  }
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireUniqueStrings(values, message) {
  requireCondition(values.every((value) => typeof value === 'string' && value) && new Set(values).size === values.length, message);
}

function equalStringSets(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function shuffleWithAuditSeed(items, seedHex) {
  const result = [...items];
  let counter = 0n;
  for (let index = result.length - 1; index > 0; index -= 1) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(counter);
    counter += 1n;
    const bytes = crypto.createHash('sha256').update(Buffer.from(seedHex, 'hex')).update(counterBuffer).digest();
    const random = bytes.readUIntBE(0, 6) / 281474976710656;
    const selected = Math.floor(random * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function parseTrustedPublicKey(value) {
  if (value instanceof crypto.KeyObject) return value.type === 'public' ? value : crypto.createPublicKey(value);
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value).trim());
  const text = bytes.toString('utf8').trim();
  try {
    if (text.startsWith('-----BEGIN PUBLIC KEY-----')) return crypto.createPublicKey(text);
    if (typeof value !== 'string' && !/^[A-Za-z0-9_-]+$/.test(text)) {
      return crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    }
    const der = Buffer.from(text, 'base64url');
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('Trusted audit public key is invalid');
  }
}

function canonicalJson(value) {
  const result = JSON.stringify(canonicalValue(value));
  if (result === undefined) throw new TypeError('Value cannot be represented as canonical JSON');
  return result;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
    return output;
  }
  throw new TypeError('Value cannot be represented as canonical JSON');
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
