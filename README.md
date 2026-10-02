# Agentic Trading Games

Agentic Trading Games is a locally hosted classroom laboratory for repeated strategic games, probabilistic reasoning, market microstructure, and human oversight of autonomous agents. One professor runs the application on a personal computer; up to 75 students join through a browser on the same network.

The project ships a coordinated student gameplay app and host-only instructor dashboard, backed by the authoritative local game server.

## Requirements

- Node.js `>=22.23.3 <23`. Windows releases pin exactly Node.js `22.23.3`.
- A stable 32-byte database key supplied as `AGENTIC_DATA_KEY` (base64 or 64-character hex) for source deployments.
- A browser on the host computer.
- An explicit TLS-protected RFC1918 classroom interface, HTTPS origin, and
  private subnet allowlist approved by campus IT for student devices.

## Run

```powershell
npm ci --ignore-scripts
$env:AGENTIC_DATA_KEY = '<base64 key from the operating-system secret manager>'
$env:STUDENT_HOST = '192.168.10.20'
$env:STUDENT_ALLOWED_CIDR = '192.168.10.0/24'
$env:STUDENT_PUBLIC_ORIGIN = 'https://games.example.edu:3000'
$env:TLS_KEY_PATH = 'C:\ProgramData\AgenticGames\tls-key.pem'
$env:TLS_CERT_PATH = 'C:\ProgramData\AgenticGames\tls-cert-chain.pem'
npm start
```

The application fails closed when the data key is missing, malformed, or wrong.
Keep it outside the repository, release directory, logs, and exports. The
Windows launcher provisions the key automatically with DPAPI CurrentUser and
stores both protected key material and encrypted app data under
`%LOCALAPPDATA%\Agentic Trading Games`.

The terminal prints two addresses after starting separate listeners:

- Student URL: share only the canonical HTTPS origin approved by campus IT.
- Instructor URL: open the one-time bootstrap URL on the host computer; its
  listener defaults to `http://127.0.0.1:3001` and is never exposed to students.

The instructor creates a session from a roster, securely delivers each student
their distinct one-time invitation, confirms the admitted identities, and then
starts the activity. The displayed six-digit code only locates that session; it
does not authorize admission.

Student entry is identity-bound. Browser recovery uses separate hashed,
expiring, revocable web sessions. A display name or consumed invitation is never
an authentication credential.

Sensitive database fields use row-bound authenticated AES-256-GCM encryption.
Domain-separated keyed row tags, a complete-set manifest, and an authenticated
SQLite-schema digest make ordinary startup reject altered metadata, deleted
rows, and injected schema objects before recovery writes. Event rows are
SHA-256 hash chained; canonical room and session audit seals bind private state,
decisions, controller/result provenance, roster identity, and effective
eligibility to an Ed25519-signed terminal root.

## Test

```powershell
npm test
npm run check
npm run audit:public-key > trusted-audit-public-key.pem
npm run verify:audit -- instructor-audit.json --public-key trusted-audit-public-key.pem
```

Pin the public key and its displayed fingerprint through an institution-approved
channel before the activity. The Windows launcher creates the same public-key
file under `%LOCALAPPDATA%\Agentic Trading Games\keys` and prints its fingerprint.
Never treat a key copied only from the audit export as trusted.

## Source of truth

- [Architecture](docs/ARCHITECTURE.md) defines trust boundaries, persistence, concurrency, and session lifecycle.
- [Game rules](docs/GAME_RULES.md) defines the implemented variants and bot policies.
- [Operations](docs/OPERATIONS.md) defines classroom startup, recovery, exports, and verification.
- [Protocol](docs/PROTOCOL.md) defines the HTTP and server-sent-events contract.
- [Frontend](docs/FRONTEND.md) defines the student and instructor interaction model and visual system.

When implementation and documentation disagree, treat that as a defect. Rule and protocol changes must update both in the same change.

## Design principles

- The server is authoritative. Browsers submit actions; they never calculate outcomes.
- Private information is projected per participant and never broadcast as full room state.
- Every accepted or rule-rejected action, random outcome, instructor intervention, and result is append-only and auditable.
- Each student action and its immediate bot response commit atomically with the decision record, RNG position, and room snapshot.
- Strategy agents use versioned, game-specific policies. The language model is not in the live rules loop.
- Students download a Markdown evidence packet and upload it manually to ChatGPT for post-game coaching.
- Raw outcomes are immutable. Instructor annotations and exclusions are recorded separately.

## Data lifecycle

The default retention target is 30 days after a session becomes completed,
voided, or archived unless institutional policy requires another period.
Terminal-only purge methods delete dependent rows transactionally, report exact
counts, truncate the WAL, and vacuum with SQLite secure deletion enabled. See
[Classroom Operations](docs/OPERATIONS.md) before exporting, retaining, or purging records.

## Attested Windows release

`npm run package:windows` runs only on 64-bit Windows with PowerShell 7
(`pwsh.exe`) on `PATH`, and only from a clean commit. It downloads the pinned
official Node.js archive, verifies its exact
SHA-256 and `node.exe` Authenticode signature, creates a stable sorted ZIP with a
file manifest and SPDX SBOM. The public GitHub workflow then creates keyless
Sigstore provenance attestations for the ZIP and checksum. No long-lived
publisher private key or PFX is stored in the repository or Actions secrets.

Release artifacts are the ZIP, its `.sha256`, and the GitHub attestation bundle.
Verify the checksum and run the following before distribution, replacing the
placeholder with the exact published tag:

```sh
gh attestation verify path/to/release.zip \
  --repo brian-se0/agentic_trading_games \
  --signer-workflow brian-se0/agentic_trading_games/.github/workflows/release-windows.yml \
  --deny-self-hosted-runners \
  --source-ref refs/tags/vX.Y.Z
```

Do not distribute or run an artifact that fails either check.
