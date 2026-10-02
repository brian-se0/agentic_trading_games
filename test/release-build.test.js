import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumManifest, createStoredZip, NODE_VERSION } from '../packaging/windows-portable/build-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('deterministic ZIP and manifest ignore insertion order and use exact content hashes', () => {
  const first = new Map([['release/z.txt', Buffer.from('last')], ['release/a.txt', Buffer.from('first')]]);
  const second = new Map([...first].reverse());
  const timestamp = new Date('2026-08-14T12:34:56Z');
  const firstZip = createStoredZip(first, timestamp);
  const secondZip = createStoredZip(second, timestamp);
  assert.deepEqual(firstZip, secondZip);
  assert.equal(firstZip.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(checksumManifest(first), checksumManifest(second));
  assert.match(checksumManifest(first), /^[a-f0-9]{64}  release\/a\.txt\n[a-f0-9]{64}  release\/z\.txt\n$/);
});

test('release metadata pins one supported Node LTS and has no runtime dependency tree', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(NODE_VERSION, '22.23.3');
  assert.equal(packageJson.engines.node, '>=22.23.3 <23');
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.deepEqual(Object.keys(lock.packages), ['']);
  assert.doesNotMatch(JSON.stringify(lock), /node_modules\/ws|"ws"/);
});

test('Windows instructions prohibit warning bypasses and keep protected data outside the release folder', () => {
  const instructions = fs.readFileSync(path.join(root, 'packaging/windows-portable/START HERE.txt'), 'utf8');
  assert.doesNotMatch(instructions, /Run anyway|Unblock checkbox|More info/i);
  assert.match(instructions, /Do not bypass a Windows\s+security warning/i);
  assert.match(instructions, /%LOCALAPPDATA%\\Agentic Trading Games/);
  assert.doesNotMatch(instructions, /same demo folder|inside its data folder/i);
});

test('Windows launcher fails closed around one TLS interface and a separate loopback instructor listener', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/launcher.mjs'), 'utf8');
  const start = fs.readFileSync(path.join(root, 'packaging/windows-portable/START_DEMO.bat'), 'utf8');
  assert.doesNotMatch(launcher, /['"]0\.0\.0\.0['"]|networkInterfaces\(|app\.server\.listen/);
  assert.match(launcher, /requiredEnvironment\('ATG_STUDENT_HOST'\)/);
  assert.match(launcher, /requiredEnvironment\('ATG_STUDENT_PUBLIC_ORIGIN'\)/);
  assert.match(launcher, /requiredEnvironment\('ATG_STUDENT_ALLOWED_CIDR'\)/);
  assert.match(launcher, /tls: \{ key: tlsKey, cert: tlsCert, minVersion: 'TLSv1\.2' \}/);
  assert.match(launcher, /listen\(app\.studentServer, configuration\.studentPort, configuration\.studentHost\)/);
  assert.match(launcher, /listen\(app\.instructorServer, configuration\.instructorPort, instructorHost\)/);
  assert.match(launcher, /hostname: studentHost[\s\S]*servername: origin\.hostname[\s\S]*Host: origin\.host/);
  assert.match(launcher, /pinAuditPublicKey\(encryptionKey\)/);
  assert.match(launcher, /trusted-audit-public-key\.pem/);
  assert.doesNotMatch(launcher, /fetch\(/);
  assert.match(start, /--use-system-ca/);
});

test('attested release carries the independent audit-key and verification tools', () => {
  const builder = fs.readFileSync(path.join(root, 'packaging/windows-portable/build-release.mjs'), 'utf8');
  assert.match(builder, /'scripts\/audit-public-key\.mjs'/);
  assert.match(builder, /'scripts\/verify-audit\.mjs'/);
  assert.match(builder, /'src\/db\.js'/);
});

test('release workflow uses pinned keyless provenance without publisher secrets', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-windows.yml'), 'utf8');
  assert.doesNotMatch(workflow, /GITHUB_ENV/);
  assert.doesNotMatch(workflow, /secrets\.|PFX|p7s/i);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /actions\/attest@[a-f0-9]{40}/);
  assert.match(workflow, /subject-path:[\s\S]*release\/\*\.zip[\s\S]*release\/\*\.sha256/);
  assert.match(workflow, /Copy-Item[\s\S]*release\/attestation\.json/);
  assert.match(workflow, /release\/attestation\.json/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
});

test('Windows builder uses one PowerShell runtime for module-compatible verification', () => {
  const builder = fs.readFileSync(path.join(root, 'packaging/windows-portable/build-release.mjs'), 'utf8');
  assert.match(builder, /const POWERSHELL = 'pwsh\.exe'/);
  assert.doesNotMatch(builder, /runFile\('powershell\.exe'/i);
  assert.equal((builder.match(/runFile\(POWERSHELL/g) ?? []).length, 2);
  assert.match(builder, /Expand-Archive/);
  assert.match(builder, /Get-AuthenticodeSignature/);
});
