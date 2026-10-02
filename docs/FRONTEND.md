# Frontend Interaction and Design

The browser has two capability-separated surfaces:

- `/` is the student flow: one-time invitation redemption, lobby, gameplay,
  completion, and a bounded personal coaching export.
- `/instructor` is the loopback-only host flow: roster provisioning, projector
  state, live table health, interventions, audit export, and retention purge.

Both clients render server projections and submit intentions. Outcomes, clocks,
eligibility, controller identity, scoring, and random state remain authoritative
on the server. Live updates use authenticated server-sent events; mutations use
same-origin HTTP requests with CSRF protection.

## Identity and session interaction

The join form accepts the displayed class code and a student-specific one-time
invitation. It does not accept a self-asserted display name. The server binds the
seat to the roster identity and returns the roster display name.

Student authorization is an HttpOnly, SameSite cookie backed by a hashed,
expiring, revocable server record. JavaScript must not store bearer credentials
in local storage or URLs. A `401` returns the student to invitation/recovery
guidance without revealing whether a roster identity exists.

The instructor roster distinguishes unused, redeemed, revoked, removed, and
expired credentials without displaying credential hashes. Newly generated or
rotated invitation plaintext is shown once for secure delivery and is not
recoverable afterward.

## Integrity state

Every active seat shows its current controller: authenticated student account,
bot, or system timeout. This is submission provenance, not proof that a human
person selected the move without automation.
If automation ever controls or acts for a student, the interface marks that
result “not competitively eligible.” Restoring human control never removes that
label. Live peer outcomes and all trading outcomes are also labeled diagnostic,
not grading-authoritative. Standings separate eligible results from
practice/mixed-control results.

Bot-controlled, paused, terminal, or unhealthy seats receive no projected legal
actions. A voided room is presented as cancelled, never as a normal score. The
client disables controls optimistically only for usability; it never treats that
as authorization or phase enforcement.

## Audit and privacy projections

Student completion views contain only the student's own decisions and permitted
public outcomes. They never receive master seeds, opponents' hidden/folded data,
roster identities, other students' private signals, or the canonical class
transcript.

The host-only audit view exposes event-chain verification, canonical room/session
seals, terminal root, controller transitions, result eligibility, private state,
and seed evidence. Purge controls require explicit confirmation and report exact
affected records.

## Visual and accessibility system

Use classroom language rather than protocol terminology. Green means connected
or accepted, red means rejected/cancelled, and amber marks a private value, turn,
automation, or item needing review. Color is always paired with text or an icon.

System fonts are the offline baseline. Controls remain keyboard- and
touch-accessible, focus survives live rerenders, important actions do not depend
on hover, reduced-motion preferences are honored, and status changes use an
appropriate live region without repeatedly announcing the entire game state.

## Classroom addresses

The instructor page shows only the explicit, TLS-protected student origin
configured for the approved classroom interface. It must not guess or advertise
every network adapter. The projector overlay displays the origin, class code,
and redeemed/expected count, but never invitation credentials.
