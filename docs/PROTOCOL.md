# HTTP and SSE Protocol

The application exposes two independent listeners. The student listener binds one explicitly selected RFC1918 IPv4 classroom interface. Hostnames, IPv6 addresses, wildcard bind hosts, public addresses, and CIDRs extending outside the matching private block are rejected so admission and connection controls use one unambiguous client-address model. Every non-loopback deployment requires an explicit TLS key and certificate (TLS 1.2 or newer, with a bounded handshake) plus a private classroom CIDR containing the selected interface; plain HTTP and an omitted CIDR are accepted only for loopback development and tests. The instructor listener binds `127.0.0.1` only and is never exposed to students.

Both listeners reject any `Host` value other than their configured canonical authority. Mutations require their exact canonical `Origin`. Event streams require that exact Origin when the browser supplies it; standards-compliant same-origin EventSource requests that omit Origin must instead carry `Sec-Fetch-Site: same-origin` and a Referer with the exact canonical origin. Responses use a restrictive CSP, deny framing, disable unneeded browser capabilities, and do not expose internal exception text.

## Student authentication

The six-digit class code identifies a lobby but does not authorize admission. The instructor imports a roster and privately distributes one high-entropy, one-time invitation per roster identity. Students submit:

```json
{ "joinCode": "123456", "inviteCode": "invite_..." }
```

Successful admission consumes the invitation and creates a fixed, non-renewable 12-hour class-day web session. Its opaque identifier is sent only in an `HttpOnly; SameSite=Strict` cookie (`Secure` outside loopback). The underlying participant token is never returned to browser JavaScript, stored in Web Storage, placed in a URL, or accepted as a bearer header. A separate SameSite CSRF cookie and matching `X-CSRF-Token` header protect cookie-authenticated mutations. Web sessions are hash-only in the database and survive controlled server restarts until they expire or are revoked.

Student endpoints:

- `GET /api/health` — minimal readiness response: `{ "ok": true }`.
- `POST /api/join` — redeem `{ joinCode, inviteCode }` and establish the cookies.
- `GET /api/me` — current private projection and CSRF value for the authenticated browser session.
- `GET /api/events` — active-session Server-Sent Events. There is at most one bounded stream per student identity. Historical or inactive identities cannot open a stream.
- `POST /api/action` — `{ actionId, actionEpoch, action }`; requires exact Origin and CSRF. The boundary applies a small body limit and per-IP/per-identity rate limits before room-queue entry.
- `POST /api/logout` — revoke the server-side web session and clear both cookies.
- `GET /api/export` — Markdown decision record or coaching packet for the current authenticated participant after completion.

## Instructor bootstrap and authentication

At process start the server prints a single-use, 256-bit bootstrap URL for the loopback instructor listener. The capability expires after ten minutes and is consumed atomically. A successful bootstrap redirects to `/instructor` and creates a process-bound, non-renewable 12-hour class-day `HttpOnly; SameSite=Strict` admin session. Merely connecting from loopback grants no privilege.

Instructor API requests require the admin cookie. Mutations additionally require the page-specific `X-CSRF-Token` and exact loopback Origin.

- `GET /api/instructor/state` — session, roster status, participants, rooms, health, and the configured student URL.
- `GET /api/instructor/events` — bounded instructor SSE stream.
- `POST /api/instructor/session` — create a session with game configuration and `roster: [{ identity, name }]`. The response contains `invitations: [{ identity, name, inviteCode }]` exactly once.
- `POST /api/instructor/roster/:inviteId/rotate` — invalidate an unused invitation and reveal its replacement once.
- `POST /api/instructor/roster/:inviteId/revoke` — permanently revoke an unused invitation.
- `POST /api/instructor/session/start`
- `POST /api/instructor/session/pause`
- `POST /api/instructor/session/resume`
- `POST /api/instructor/session/end`
- `POST /api/instructor/session/void`
- `POST /api/instructor/room/:roomId/void`
- `POST /api/instructor/participant/:id/remove`
- `POST /api/instructor/participant/:id/replace`
- `POST /api/instructor/participant/:id/restore`
- `GET /api/instructor/export/:participantId`
- `GET /api/instructor/audit-export` — instructor-only canonical private audit for either completed or voided activities.
- `GET /api/instructor/audit-export.json` — the same terminal activity's canonical
  machine-verifiable audit object. Room and session seals bind all exported
  non-event records, deterministic seating and exact seat topology are replayed,
  and every action, timeout, controller transition, room disposition, and seal is
  reconciled in order. The versioned event vocabulary rejects unknown names and
  room/session scope mismatches. Ed25519 authenticates the terminal root.
  Verification requires a public key pinned separately from the export.
- `POST /api/instructor/purge` — permanently purge terminal classroom records
  past the retention cutoff, including the latest activity when eligible;
  requires `{ "confirmation": "PURGE ARCHIVED DATA" }`.

## Server-Sent Events

The browser opens EventSource on `/api/events` or `/api/instructor/events`; neither endpoint accepts credentials in its URL. Events contain one complete permitted projection in their `data` field. Event names are `snapshot`, `room_update`, `session_update`, and `health`.

The protocol is intentionally server-to-client only, so WebSocket upgrades and inbound application messages are unsupported. Streams have global and per-identity caps, a 256 KiB prospective queue bound, coalescing while backpressured, forced slow-consumer termination, periodic liveness checks, and short-lived session authorization.
