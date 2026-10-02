# Architecture Source of Truth

## Deployment and trust boundaries

One Node.js process owns the authoritative game state and encrypted SQLite
database. It exposes two deliberately separate listeners:

- The student listener binds one explicit RFC1918 IPv4 interface. Non-loopback
  use requires TLS, a canonical HTTPS origin, and a CIDR contained entirely in
  that same private block and containing the selected interface.
  Wildcard binds are rejected.
- The instructor listener binds only `127.0.0.1`. Loopback is a network
  boundary, not authentication: a single-use 256-bit launch capability creates
  a 12-hour, non-renewable HttpOnly instructor session, and mutations also
  require CSRF.

Both listeners enforce canonical `Host` and browser `Origin`/fetch metadata,
bounded request bodies, global and per-network limits, connection ceilings,
generic internal errors, and restrictive browser security headers. Browser
updates use one-way, bounded Server-Sent Events. WebSocket upgrades are rejected.

The trusted computing base is the professor-controlled host operating-system
account, the running server process, its DPAPI/data and TLS keys, and the channel
used to pin the audit public key. Student browsers, the classroom network, and
files received after an activity are untrusted. Field encryption fails closed
on altered or downgraded protected values, but it is not a claim that a host
administrator who can replace the process, keys, and a coherent database
history is contained. An institution requiring rollback evidence against host
compromise must synchronously anchor each committed audit head/counter to a
separately administered remote WORM log or hardware-backed monotonic service
before accepting the next decision. A mutable local file cannot provide that
external freshness boundary.

## Admission and authorization

The six-digit class code locates a lobby; it never creates an identity. The
instructor provisions a roster containing a stable institutional identity and
display name. Each entry receives a distinct high-entropy invitation that can
be redeemed exactly once in the same atomic transaction that creates the
participant and browser session. Database uniqueness enforces one active seat
per roster identity. Removed lobby participants can receive a new invitation;
an active identity cannot.

Students use a Secure, HttpOnly, SameSite browser-session cookie backed by a
hashed, 12-hour, revocable database row. A separate SameSite cookie supplies the
double-submit CSRF value. Participant bearer tokens are not exposed to browser
JavaScript, local storage, headers, URLs, or live-update connections.

## Authoritative state and privacy

Clients submit intentions, never state replacements. Engines enforce exact
action schemas, turn ownership, epochs, prices/ticks, balances, inventory,
phase, and deadlines. Student projections omit other players' dice, cards,
folded cards, private signals, uncommitted simultaneous choices, master seeds,
roster identities, and instructor annotations.

The instructor sees operational state and receives the protected terminal
class audit. Neither browser is trusted to calculate outcomes, eligibility,
clocks, or legal actions.

## Lifecycle and concurrency

The durable lifecycle is:

`LOBBY -> RUNNING <-> PAUSED -> ENDING -> COMPLETED`

An instructor may instead enter `VOIDING -> VOIDED`. Transient lock/pause/resume
states are barriers, not alternate terminal outcomes. Configuration and seating
become immutable at start.

Each room is a serialized actor with a bounded promise queue. A student action,
its accepted-action id, immutable pre-action decision record, immediate bot
steps, RNG movement, events, room snapshot, and any terminal seal commit in one
synchronous SQLite transaction. In-memory state is checkpointed and restored
if persistence fails. Pause/resume drains all affected room queues and updates
every room atomically. Deadline checks occur again inside the room actor so a
late action cannot win a timer race.

Persisted student attempts are durably capped at 300 per student, 4,200 per
room, and 45,000 per activity. The aggregate ceilings equal the full
150-student per-identity allocation, so one account cannot consume another
account's allowance. Valid no-fill market orders and the bounded recorded
rejections both consume this storage allowance; rejection frequency is also
bounded separately per decision epoch. Trading advances at most one automated
server order per room scheduler pass, so configured room count and duration
also bound bot-generated events.

Non-trading human turns have persisted deadlines. A deterministic timeout move
is recorded with system controller provenance and permanently withdraws that
student's competitive-result eligibility. Connected clients are not exempt.
Trading uses a serialized monotonic remaining-time clock that survives pause
and restart.

## Persistence, encryption, and audit

SQLite uses WAL, foreign keys, secure deletion, and SQLite 3.51.3 or newer.
Every sensitive field is protected with AES-256-GCM under a required 32-byte
installation key, including identities, names, configuration, room seeds and
state, events, decisions, annotations, results, and settings. Equality lookup
uses keyed indexes where necessary. The Windows launcher keeps the encrypted
database in LocalAppData and protects the data key with DPAPI CurrentUser.

Every security-relevant row is also covered by a domain-separated keyed tag
over all semantic columns. An authenticated set manifest commits the complete
row-key/tag membership and the exact application `sqlite_schema` digest. Before
registering keyed SQLite functions or performing a startup write, the database
preflight rejects unknown schema objects, altered trigger/index/table SQL,
missing rows, orphaned tags, and invalid manifests. A full row/set/schema check
runs before the terminal session seal and again before its Ed25519 signature.
Room snapshot envelopes bind the current room sequence and RNG counter, and
restore also requires the snapshot sequence to equal the canonical room-event
head.

Normal startup accepts only row-bound authenticated envelopes and the integrity
manifest; plaintext and unrecognized envelopes are never trusted. Mixed or
altered data fail authentication instead of being normalized by the live service.

Core records include sessions, roster invitations, participants, durable web
sessions, rooms, accepted-action ids, events, decisions, controller transitions,
result provenance, and annotations. Event writes form one session-wide canonical
SHA-256 chain.

At terminal room disposition, `room_audit_sealed` commits a canonical digest of
the room metadata, players, private final state, all decisions, controller
transitions, and immutable result rows. The room seal is the room transcript
root. Once the session becomes completed or voided, `session_audit_sealed`
commits the session record, sorted roster, room seals/dispositions, all
controller transitions, and effective eligibility. It is the final event-chain
root. That root is signed with an Ed25519 installation key derived by HKDF from
the protected data key. `scripts/verify-audit.mjs` independently recomputes the
chain, commitments, bundles, provenance coverage, and session seal, then
requires the Ed25519 signature to match a public key pinned outside the export.
An export's embedded public key is descriptive and is never its own trust anchor.
The verifier also reconciles session creation/disposition, deterministic
seating, room/player topology, roster identity bindings, every accepted,
rejected, or timed-out decision, and every controller transition against the
canonical event stream. Event names have an exhaustive,
version-pinned scope: room events require a known same-session room and positive
sequence, session events require null room/sequence, and unknown or cross-scope
events are rejected both when written and when independently verified.

Terminal room provenance is append-only. Cancelling a whole session never
rewrites a room that already sealed; the session seal makes its effective
eligibility false. Interrupted ending/voiding and rules-version quarantine are
idempotent. Unknown rule schemas are kept opaque and quarantined before current
engines can deserialize them; unfinished incompatible rooms must be voided.

## Randomness and seating

Every room and seating draw uses 256 bits of operating-system entropy with a
SHA-256 commitment and deterministic SHA-256 counter generator. Seating is
CSPRNG-shuffled only after the lobby is atomically locked. The full seed and
canonical transcript are instructor-only after terminal disposition. Students
receive commitments and permitted outcomes, never a master seed that could
reconstruct opponents' hidden information.

The audit binds a grouping policy identifier. The independent verifier replays
the committed shuffle, deterministic room chunking, room creation order,
game-specific seat totals, and exact server-bot/market-maker policy; an
internally consistent but regrouped roster does not verify. Every session also
binds the identifier in its encrypted configuration. A missing or mismatched
identifier fails closed at startup.

## Result and coaching boundary

Authenticated student submissions remain pedagogically useful in every mode.
They prove the submitting account/session, not unaided human cognitive
authorship. A browser cannot reliably distinguish a person's choice from a
script using that person's valid session; assessments that require this
distinction need an independently supervised/evaluated boundary.
Competitive outcome metrics are narrower:

- live peer-dependent outcomes are diagnostic only because colluding students
  can transfer wins or wealth;
- trading P/L and execution outcomes are non-authoritative for grading;
- random/strategy outcomes become eligible only after the entire session is
  completed and only when the seat remained controlled by the authenticated
  student session throughout.

Rejected and automated actions are separately labeled and excluded from human
strategy-agreement metrics. Student Markdown is a bounded coaching artifact,
not the canonical grading record and not an instruction authority. It contains
only normalized server-generated action schemas. The application makes no
OpenAI API call.

## Failure and retention policy

Typed rule errors are bounded rejected decisions. Unexpected engine failures
roll back the action and quarantine only that room. Persistence failures do not
consume action ids or contaminate in-memory state. Slow event-stream consumers
are coalesced and then terminated within a fixed buffer/time bound.

Terminal sessions are retained for the institution's documented period (30
days by default), then purged transactionally with exact row counts, WAL
truncation, secure deletion, and vacuum. The protected audit export—not a copied
SQLite file—is the portable academic record.
