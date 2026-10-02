import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
export const NODE_VERSION = '22.23.3';
export const NODE_ARCHIVE_SHA256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71';
const NODE_ARCHIVE_NAME = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_ARCHIVE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}`;
const RELEASE_DIRECTORY_NAME = 'Agentic Trading Games Demo - Windows x64';
const POWERSHELL = 'pwsh.exe';
const SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'src/db.js',
  'src/games.js',
  'src/platform.js',
  'src/random.js',
  'src/server.js',
  'scripts/audit-public-key.mjs',
  'scripts/verify-audit.mjs',
  'public/app.js',
  'public/index.html',
  'public/instructor.html',
  'public/instructor.js',
  'public/styles.css',
  'packaging/windows-portable/app-data.mjs',
  'packaging/windows-portable/launcher.mjs',
  'packaging/windows-portable/stop-demo.mjs',
  'packaging/windows-portable/START_DEMO.bat',
  'packaging/windows-portable/STOP_DEMO.bat',
  'packaging/windows-portable/START HERE.txt',
  'packaging/windows-portable/THIRD-PARTY NOTICES.txt',
];

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function checksumManifest(entries) {
  return [...entries]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join('\n') + '\n';
}

export function createStoredZip(entries, timestamp) {
  const ordered = [...entries].sort(([left], [right]) => left.localeCompare(right, 'en'));
  const { date, time } = dosTimestamp(timestamp);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contents] of ordered) {
    const filename = Buffer.from(name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.from(contents);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  if (ordered.length > 0xffff) throw new Error('ZIP file count exceeds the deterministic format limit');
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function dosTimestamp(value) {
  const source = new Date(value);
  const year = Math.min(2107, Math.max(1980, source.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((source.getUTCMonth() + 1) << 5) | source.getUTCDate(),
    time: (source.getUTCHours() << 11) | (source.getUTCMinutes() << 5) | Math.floor(source.getUTCSeconds() / 2),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit += 1) current = (current >>> 1) ^ ((current & 1) ? 0xedb88320 : 0);
  return current >>> 0;
});

function crc32(contents) {
  let value = 0xffffffff;
  for (const byte of contents) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function git(...arguments_) {
  const { stdout } = await runFile('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  return stdout.trim();
}

async function gitBlob(commit, filename) {
  const { stdout } = await runFile('git', ['show', `${commit}:${filename}`], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function assertCleanTrackedCommit() {
  const status = await git('status', '--porcelain=v1', '--untracked-files=all');
  if (status) throw new Error(`Release builds require a clean commit; working tree changes found:\n${status}`);
  const head = await git('rev-parse', 'HEAD');
  await git('cat-file', '-e', `${head}^{commit}`);
  const trackedApplicationFiles = (await git('ls-files', 'src', 'public')).split('\n').filter(Boolean).sort();
  const expectedApplicationFiles = SOURCE_FILES.filter((name) => name.startsWith('src/') || name.startsWith('public/')).sort();
  if (JSON.stringify(trackedApplicationFiles) !== JSON.stringify(expectedApplicationFiles)) {
    throw new Error('The deterministic source allowlist does not exactly match tracked src/public files');
  }
  for (const filename of SOURCE_FILES) await git('ls-files', '--error-unmatch', filename);
  return head;
}

async function downloadRuntime(destination) {
  const response = await fetch(NODE_ARCHIVE_URL, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node.js runtime download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== NODE_ARCHIVE_SHA256) throw new Error('Node.js runtime checksum verification failed');
  await fs.writeFile(destination, data, { flag: 'wx' });
}

async function extractRuntime(archive, destination) {
  const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:ATG_NODE_ARCHIVE -DestinationPath $env:ATG_NODE_DESTINATION`;
  await runFile(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', script,
  ], {
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, ATG_NODE_ARCHIVE: archive, ATG_NODE_DESTINATION: destination },
  });
}

async function verifyNodeAuthenticode(nodeExecutable) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:ATG_NODE_EXE
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
  throw "Node.js Authenticode verification failed: $($signature.Status)"
}
if (-not $signature.SignerCertificate) { throw 'Node.js has no Authenticode signer certificate.' }
`;
  await runFile(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', script,
  ], { windowsHide: true, timeout: 30_000, env: { ...process.env, ATG_NODE_EXE: nodeExecutable } });
}

function buildInfo({ commit, created }) {
  return `AGENTIC TRADING GAMES - PORTABLE WINDOWS BUILD\n${'='.repeat(47)}\n\n`
    + `Application version: 0.1.0\nApplication source commit: ${commit}\n`
    + `Reproducible source timestamp: ${created}\nTarget: 64-bit Windows 10 or Windows 11\n`
    + `Portable launcher format: 2\n\nBundled runtime: Node.js v${NODE_VERSION}, Windows x64\n`
    + `Official download: ${NODE_ARCHIVE_URL}\nOfficial ZIP SHA-256: ${NODE_ARCHIVE_SHA256}\n\n`
    + 'The runtime archive checksum and node.exe Authenticode signature were verified during the build.\n'
    + 'The release workflow publishes keyless GitHub/Sigstore provenance for the ZIP and checksum.\n'
    + 'This package contains no classroom database, data key, student records, or Git history.\n';
}

function spdxDocument(entries, { commit, created }) {
  const files = [...entries].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([name, contents], index) => ({
    SPDXID: `SPDXRef-File-${index + 1}`,
    fileName: `./${name}`,
    checksums: [{ algorithm: 'SHA256', checksumValue: sha256(contents) }],
    licenseConcluded: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  }));
  return JSON.stringify({
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `Agentic Trading Games Windows ${commit.slice(0, 12)}`,
    documentNamespace: `https://agentic-trading-games.invalid/spdx/${commit}`,
    creationInfo: { created, creators: ['Tool: packaging/windows-portable/build-release.mjs'] },
    packages: [
      { SPDXID: 'SPDXRef-Package-App', name: 'agentic-trading-games', versionInfo: '0.1.0', downloadLocation: 'NOASSERTION',
        filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION' },
      { SPDXID: 'SPDXRef-Package-Node', name: 'Node.js', versionInfo: NODE_VERSION, downloadLocation: NODE_ARCHIVE_URL, filesAnalyzed: false,
        checksums: [{ algorithm: 'SHA256', checksumValue: NODE_ARCHIVE_SHA256 }],
        licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'Copyright Node.js contributors' },
    ],
    files,
    relationships: files.map((file) => ({ spdxElementId: 'SPDXRef-Package-App', relationshipType: 'CONTAINS', relatedSpdxElement: file.SPDXID })),
  }, null, 2) + '\n';
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The Windows release must be built on 64-bit Windows');
  }
  const commit = await assertCleanTrackedCommit();
  const epoch = process.env.SOURCE_DATE_EPOCH || await git('show', '-s', '--format=%ct', commit);
  if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be whole Unix seconds');
  const sourceDate = new Date(Number(epoch) * 1_000);
  const created = sourceDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-games-release-'));
  try {
    const archive = path.join(temporary, NODE_ARCHIVE_NAME);
    const extracted = path.join(temporary, 'node');
    await downloadRuntime(archive);
    await fs.mkdir(extracted);
    await extractRuntime(archive, extracted);
    const runtimeRoot = path.join(extracted, `node-v${NODE_VERSION}-win-x64`);
    const nodeExecutable = path.join(runtimeRoot, 'node.exe');
    await verifyNodeAuthenticode(nodeExecutable);

    const payload = new Map();
    for (const filename of SOURCE_FILES) {
      const archiveName = filename.startsWith('packaging/windows-portable/')
        ? filename.slice('packaging/windows-portable/'.length)
        : filename;
      payload.set(`${RELEASE_DIRECTORY_NAME}/${archiveName}`, await gitBlob(commit, filename));
    }
    payload.set(`${RELEASE_DIRECTORY_NAME}/runtime/node.exe`, await fs.readFile(nodeExecutable));
    payload.set(`${RELEASE_DIRECTORY_NAME}/runtime/LICENSE.txt`, await fs.readFile(path.join(runtimeRoot, 'LICENSE')));
    payload.set(`${RELEASE_DIRECTORY_NAME}/BUILD INFO.txt`, Buffer.from(buildInfo({ commit, created })));
    const sbomName = `${RELEASE_DIRECTORY_NAME}/SBOM.spdx.json`;
    payload.set(sbomName, Buffer.from(spdxDocument(payload, { commit, created })));
    const manifestName = `${RELEASE_DIRECTORY_NAME}/MANIFEST.sha256`;
    payload.set(manifestName, Buffer.from(checksumManifest(payload)));

    const zip = createStoredZip(payload, sourceDate);
    const releaseBase = `agentic-trading-games-${commit.slice(0, 12)}-win-x64`;
    const zipName = `${releaseBase}.zip`;
    const checksumName = `${zipName}.sha256`;
    const temporaryZip = path.join(temporary, zipName);
    const temporaryChecksum = path.join(temporary, checksumName);
    await fs.writeFile(temporaryZip, zip, { flag: 'wx' });
    await fs.writeFile(temporaryChecksum, `${sha256(zip)}  ${zipName}\n`, { flag: 'wx' });

    const outputDirectory = path.join(repositoryRoot, 'release');
    await fs.mkdir(outputDirectory, { recursive: true });
    for (const [name, source] of [[zipName, temporaryZip], [checksumName, temporaryChecksum]]) {
      await fs.copyFile(source, path.join(outputDirectory, name), fsConstants.COPYFILE_EXCL);
    }
    console.log(`Deterministic release created in ${outputDirectory}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
