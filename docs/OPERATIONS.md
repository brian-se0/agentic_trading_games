# Classroom Operations

## Approved deployment

Use Node.js `>=22.23.3 <23`; the Windows release pins exactly `22.23.3`. Install
the exact lockfile with `npm ci --ignore-scripts`. The application has no
third-party runtime packages.

For a source deployment, provision one stable 32-byte `AGENTIC_DATA_KEY` from
the operating-system secret manager before startup. A missing, malformed, or
wrong key stops database startup. Never put the key in source control, the
application directory, a release ZIP, logs, or a classroom export.

The Windows launcher creates the key once and stores only its DPAPI
CurrentUser-protected form under `%LOCALAPPDATA%\Agentic Trading Games\keys`.
The encrypted database is under `%LOCALAPPDATA%\Agentic Trading Games\data`.
The application directory remains immutable and contains no classroom data.
On first start the launcher also writes the non-secret
`trusted-audit-public-key.pem` under the LocalAppData `keys` directory and prints
its SHA-256 fingerprint. Record/pin that key through an approved channel before
the class; do not obtain the trust anchor from the later audit export.

Run the host from a dedicated, patched professor account. Students must not
receive local login, filesystem, remote-desktop, debugger, or administrator
access to that account or machine. At-rest encryption protects lost storage and
detects altered protected fields; it does not turn a compromised host into a
trusted authority. Where policy requires rollback evidence against the host
itself, provision the separately administered remote/hardware audit-head anchor
described in the architecture before classroom use. That service must enforce
a monotonic per-activity head and acknowledge each committed head before the
application accepts the next decision; copying a local checkpoint elsewhere
only at completion is not rollback protection.

Non-loopback student access requires an institution-approved TLS certificate,
an explicit RFC1918 interface, a public HTTPS origin, and a subnet allowlist
contained entirely within that private block.
Do not bind an unencrypted listener to every interface. Confirm the exact
network and certificate with campus IT before class.

Source deployments set `STUDENT_HOST`, `STUDENT_ALLOWED_CIDR`,
`STUDENT_PUBLIC_ORIGIN`, `TLS_KEY_PATH`, and `TLS_CERT_PATH`; student and
instructor ports default to 3000 and 3001. The attested Windows launcher uses the
equivalent `ATG_`-prefixed variables documented in `START HERE.txt` and fails
closed unless the host/CIDR are private, the HTTPS origin has the same port, and
the PEM paths are absolute.

## Startup

1. Verify the release ZIP checksum and its GitHub provenance using the exact
   published tag:
   `gh attestation verify path/to/release.zip --repo brian-se0/agentic_trading_games`
   `--signer-workflow brian-se0/agentic_trading_games/.github/workflows/release-windows.yml`
   `--deny-self-hosted-runners --source-ref refs/tags/vX.Y.Z`.
2. Connect the professor computer to the approved classroom network.
3. Start the attested release, or run `npm start` with the data key and TLS settings provisioned.
   For source installs, run `npm run audit:public-key > trusted-audit-public-key.pem`
   first and pin the printed fingerprint.
4. Leave the host terminal running and open the loopback-only instructor URL.
5. Create the session from an identity-bound roster.
6. Deliver each one-time invitation to its matching student through an authenticated channel.
7. Confirm the expected identities and readiness before starting.

Display names are labels, not identities. Do not create a shared invitation or
admit name-only joins. Rotate an unused invitation if it may have been disclosed;
remove a redeemed lobby participant before issuing a replacement credential.

## During class

- Use global pause before explaining a rule or resolving a connection issue.
- Pause freezes trading clocks and removes student legal actions until resume.
- An automated timeout or bot takeover permanently makes that participant's
  result competitively ineligible. Restoration returns control but not eligibility.
- Treat every live peer outcome and every trading outcome as diagnostic only;
  use authenticated student submission records for evaluation.
- Browser authentication proves which account submitted an action, not that a
  person chose it unaided. If human authorship is an assessment requirement,
  use an independently supervised/evaluated submission boundary.
- Prefer voiding a technically compromised room over editing its result.
- Instructor actions and controller transitions are append-only audit records.
- A failed audit-chain verification is an integrity incident: stop scoring and
  preserve the database and logs for review.

## Completion and exports

Students receive only their bounded post-game coaching export. It must omit the
master seed, opponents' folded/private state, instructor annotations, roster
identities, and the complete transcript.

The instructor-only class audit contains canonical events, private terminal
state, controller/result provenance, seed evidence, room-bundle seals, the final
session seal, and the Ed25519-signed terminal SHA-256 event-chain root. Verify
the JSON export before relying on it:

```sh
npm run verify:audit -- instructor-audit.json --public-key trusted-audit-public-key.pem
```

Treat it as a protected academic record. A terminal result is immutable;
corrections are new annotations or explicit exclusions.

Participant credentials expire and can be revoked. Redeemed invitations are not
authentication recovery mechanisms. Browser recovery uses a separate, hashed,
expiring, revocable web-session record. Terminal access remains read-only until
logout, explicit revocation, activity replacement, or the fixed 12-hour expiry.

## Retention and purge

The default operational target is 30 days after completion/void/archive unless
a documented institutional record schedule requires another period. Review and
export authorized records before purge.

Database lifecycle methods are explicit and terminal-only:

- `retentionCandidates(cutoff)` previews eligible sessions.
- `purgeCompletedSessions({ before, excludeSessionId, compact })` applies the
  default 30-day cutoff when `before` is omitted and returns per-table counts.
- `purgeSession(sessionId)` rejects a non-terminal session.
- `purgeExpiredWebSessions(at)` removes expired or revoked browser sessions.

Purge deletes dependent records in one transaction, enables SQLite secure
deletion, truncates the WAL, and vacuums by default. A purge is destructive and
must require an explicit instructor confirmation in the host-only UI.

## Recovery and key custody

Restart with the same database and encryption key. A browser refresh resumes
only while its web session and underlying participant authorization are both
unexpired and unrevoked. Room snapshots, event roots, and provenance survive a
controlled restart.

The encrypted SQLite file is not a standalone backup. Recovery requires the
database plus access to the same protected key. Use an institution-approved,
access-controlled backup procedure and test restoration. Loss of the DPAPI
Windows profile or source-deployment secret makes the data unrecoverable; there
is intentionally no plaintext or key-recovery fallback.

Normal startup requires authenticated row-bound envelopes, a complete integrity
manifest, and the expected database schema. It rejects plaintext and altered
data rather than converting them during recovery.

## Verification checklist

- `npm test` and `npm run check` pass on a supported Node runtime.
- A fresh database fails closed without a valid 32-byte data key.
- Raw SQLite fields contain authenticated ciphertext for identities, private
  room state/seeds, events, decisions, settings, annotations, and results.
- Startup authenticates every semantic row, complete row membership, and the
  exact SQLite schema before recovery can write. Injected or modified schema
  objects and deleted/replayed protected rows fail closed.
- `verifyEventChain(sessionId)` succeeds and the following command recomputes
  the event chain, deterministic seating, roster/room topology, exact
  action-decision/controller coverage, room bundles, provenance, and terminal
  session seal:

  ```sh
  npm run verify:audit -- <file> --public-key <separately-pinned-key>
  ```
- Duplicate/redeemed/revoked invitations and expired/revoked credentials fail.
- Instructor APIs remain loopback-only; student TLS/origin/subnet controls are enforced.
- A bot/system-controlled action permanently marks the result ineligible.
- A retention preview and test purge report the expected dependent-row counts.
- The Windows ZIP is reproducible from a clean commit and its checksum signature verifies.
