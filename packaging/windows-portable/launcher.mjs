import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { auditPublicKeyFromDataKey } from './src/db.js';
import { createApplication } from './src/server.js';
import { getOrCreateDataKey, windowsAppDataRoot } from './app-data.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const appDataRoot = windowsAppDataRoot();
const controlDirectory = path.join(appDataRoot, 'launcher');
const ownerLockDirectory = path.join(controlDirectory, 'owner.lock');
const ownerFile = path.join(ownerLockDirectory, 'owner.json');
const readyFile = path.join(ownerLockDirectory, 'ready.json');
const instructorHost = '127.0.0.1';

function stopRequestFile(launchId) {
  return path.join(controlDirectory, `stop-request-${launchId}.json`);
}

function stopResultFile(launchId) {
  return path.join(controlDirectory, `stop-result-${launchId}.json`);
}

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`Campus IT must set ${name} before this classroom server can start.`);
  return value;
}

function configuredPort(name, fallback) {
  const value = process.env[name] ?? fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer from 1024 through 65535.`);
  }
  return parsed;
}

const noBrowser = process.argv.includes('--no-browser');

function separator(character = '=') {
  console.log(character.repeat(68));
}

function isPrivateIpv4(address) {
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function ipv4Number(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function dottedIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function validatePrivateCidr(cidr, studentHost) {
  const match = String(cidr).match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  const address = match ? ipv4Number(match[1]) : null;
  const prefix = match ? Number(match[2]) : -1;
  if (address == null || prefix < 8 || prefix > 32) {
    throw new Error('ATG_STUDENT_ALLOWED_CIDR must be an explicit private IPv4 CIDR with a prefix from /8 through /32.');
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = address & mask;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  if (!isPrivateIpv4(dottedIpv4(network)) || !isPrivateIpv4(dottedIpv4(broadcast))) {
    throw new Error('ATG_STUDENT_ALLOWED_CIDR must stay entirely within one RFC1918 private network.');
  }
  const host = ipv4Number(studentHost);
  if (host == null || (host & mask) !== network) {
    throw new Error('ATG_STUDENT_HOST must belong to ATG_STUDENT_ALLOWED_CIDR.');
  }
}

function classroomConfiguration() {
  const studentHost = requiredEnvironment('ATG_STUDENT_HOST');
  if (net.isIP(studentHost) !== 4 || !isPrivateIpv4(studentHost)) {
    throw new Error('ATG_STUDENT_HOST must select one RFC1918 IPv4 address assigned to the approved classroom interface.');
  }
  const studentAllowedCidr = requiredEnvironment('ATG_STUDENT_ALLOWED_CIDR');
  validatePrivateCidr(studentAllowedCidr, studentHost);
  const studentPublicOrigin = requiredEnvironment('ATG_STUDENT_PUBLIC_ORIGIN');
  let origin;
  try {
    origin = new URL(studentPublicOrigin);
  } catch {
    throw new Error('ATG_STUDENT_PUBLIC_ORIGIN must be a valid HTTPS origin.');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('ATG_STUDENT_PUBLIC_ORIGIN must contain only an HTTPS scheme, hostname, and optional port.');
  }
  const testPort = argumentValue('test-port');
  const studentPort = testPort === undefined
    ? configuredPort('ATG_STUDENT_PORT', 3000)
    : configuredPort('internal test port', testPort);
  const instructorPort = configuredPort('ATG_INSTRUCTOR_PORT', studentPort + 1);
  if (studentPort === instructorPort) throw new Error('ATG_STUDENT_PORT and ATG_INSTRUCTOR_PORT must be different.');
  const originPort = Number(origin.port || 443);
  if (originPort !== studentPort) {
    throw new Error('ATG_STUDENT_PUBLIC_ORIGIN must use the same port as ATG_STUDENT_PORT.');
  }
  const tlsKeyPath = requiredEnvironment('ATG_TLS_KEY_PATH');
  const tlsCertPath = requiredEnvironment('ATG_TLS_CERT_PATH');
  if (!path.isAbsolute(tlsKeyPath) || !path.isAbsolute(tlsCertPath)) {
    throw new Error('ATG_TLS_KEY_PATH and ATG_TLS_CERT_PATH must be absolute paths provisioned by campus IT.');
  }
  return {
    studentHost,
    studentAllowedCidr,
    studentPublicOrigin: origin.origin,
    studentPort,
    instructorPort,
    tlsKeyPath,
    tlsCertPath,
  };
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function validOwner(owner) {
  return owner?.version === 2
    && typeof owner.launchId === 'string'
    && owner.launchId.length >= 16
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && Number.isInteger(owner.studentPort)
    && owner.studentPort >= 1024
    && owner.studentPort <= 65535
    && Number.isInteger(owner.instructorPort)
    && owner.instructorPort >= 1024
    && owner.instructorPort <= 65535
    && typeof owner.studentOrigin === 'string'
    && owner.studentOrigin.startsWith('https://')
    && net.isIP(owner.studentHost) === 4
    && typeof owner.projectRoot === 'string'
    && typeof owner.startedAt === 'string'
    && Number.isFinite(Date.parse(owner.startedAt));
}

async function healthy({ studentPublicOrigin, studentOrigin, studentHost }, timeoutMilliseconds = 1_000) {
  const origin = new URL(studentPublicOrigin ?? studentOrigin);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = https.request({
      hostname: studentHost,
      port: Number(origin.port || 443),
      servername: origin.hostname,
      method: 'GET',
      path: '/api/health',
      rejectUnauthorized: true,
      headers: { Host: origin.host, Accept: 'application/json', Connection: 'close' },
      timeout: timeoutMilliseconds,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 256) request.destroy(new Error('Health response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(response.statusCode === 200 && body?.ok === true && Object.keys(body).length === 1);
        } catch {
          finish(false);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('Health check timed out')));
    request.once('error', () => finish(false));
    request.end();
  });
}

async function waitForHealth(configuration, timeoutMilliseconds = 15_000, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (await healthy(configuration)) return true;
    await delay(200);
  }
  return false;
}

function openBrowser(url) {
  if (noBrowser) return;
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => {
      console.error(`The browser did not open automatically. Open it yourself and enter: ${url}`);
    });
    child.unref();
  } catch {
    console.error(`The browser did not open automatically. Open it yourself and enter: ${url}`);
  }
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function verifyPortIsAvailable(port, host) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      probe.once('error', onError);
      probe.listen({ port, host, exclusive: true }, () => {
        probe.off('error', onError);
        resolve();
      });
    });
  } finally {
    if (probe.listening) {
      await new Promise((resolve) => probe.close(resolve));
    }
  }
}

async function waitForOwner(timeoutMilliseconds = 1_500) {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const owner = await readJson(ownerFile);
    if (owner) return owner;
    await delay(100);
  } while (Date.now() < deadline);
  return null;
}

async function lockAgeMilliseconds() {
  try {
    const stat = await fs.stat(ownerLockDirectory);
    return Date.now() - stat.mtimeMs;
  } catch {
    return 0;
  }
}

async function quarantineStaleLock() {
  const quarantine = `${ownerLockDirectory}.stale-${crypto.randomUUID()}`;
  try {
    await fs.rename(ownerLockDirectory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

async function acquireOwnership(configuration, projectRoot) {
  await fs.mkdir(controlDirectory, { recursive: true });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const launchId = crypto.randomUUID();
    const candidateDirectory = path.join(controlDirectory, `owner.lock.candidate-${launchId}`);
    const candidateOwnerFile = path.join(candidateDirectory, 'owner.json');
    const owner = {
      version: 2,
      launchId,
      pid: process.pid,
      studentPort: configuration.studentPort,
      instructorPort: configuration.instructorPort,
      studentOrigin: configuration.studentPublicOrigin,
      studentHost: configuration.studentHost,
      projectRoot,
      startedAt: new Date().toISOString(),
    };

    try {
      await fs.mkdir(candidateDirectory);
      await fs.writeFile(candidateOwnerFile, JSON.stringify(owner, null, 2), { flag: 'wx' });
      await fs.rename(candidateDirectory, ownerLockDirectory);
      return { owned: true, owner };
    } catch (error) {
      await fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
      if (!(await fs.stat(ownerLockDirectory).then(() => true, () => false))) throw error;
    }

    const existing = await waitForOwner();
    if (validOwner(existing)) {
      const sameFolder = path.resolve(existing.projectRoot).toLocaleLowerCase('en-US') === projectRoot.toLocaleLowerCase('en-US');
      if (processIsAlive(existing.pid)) {
        if (await waitForHealth(existing, 3_000)) return { owned: false, owner: existing };
        const age = Date.now() - Date.parse(existing.startedAt);
        const phase = (await readJson(readyFile))?.launchId === existing.launchId ? 'running' : 'starting';
        if (sameFolder && phase === 'starting' && age < 30_000) {
          throw new Error('Another copy is still starting. Wait 30 seconds and try START_DEMO again.');
        }
        throw new Error('A previous copy still owns this demo folder but is not responding. Use STOP_DEMO, restart Windows, or contact the sender.');
      }
      if (await quarantineStaleLock()) continue;
    } else if ((await lockAgeMilliseconds()) > 10_000) {
      if (await quarantineStaleLock()) continue;
    } else {
      throw new Error('Another copy is beginning to start. Wait a few seconds and try START_DEMO again.');
    }
    await delay(100);
  }
  throw new Error('The launcher could not safely take ownership of this demo folder. Restart Windows or contact the sender.');
}

async function showExistingDemo(owner) {
  const instructorUrl = `http://${instructorHost}:${owner.instructorPort}/instructor`;
  separator();
  console.log('THE DEMO IS ALREADY RUNNING');
  separator();
  console.log(`Instructor page: ${instructorUrl}`);
  console.log('The instructor page will be opened again now.');
  openBrowser(instructorUrl);
}

async function writeJsonAtomically(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function pinAuditPublicKey(encryptionKey) {
  const keyDirectory = path.join(appDataRoot, 'keys');
  const filename = path.join(keyDirectory, 'trusted-audit-public-key.pem');
  const publicKey = auditPublicKeyFromDataKey(encryptionKey);
  await fs.mkdir(keyDirectory, { recursive: true });
  try {
    await fs.writeFile(filename, publicKey, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(filename, 'utf8');
    if (existing !== publicKey) throw new Error('The pinned audit public key does not match the protected classroom data key.');
  }
  const keyObject = crypto.createPublicKey(publicKey);
  const fingerprint = crypto.createHash('sha256')
    .update(keyObject.export({ format: 'der', type: 'spki' })).digest('hex');
  return { filename, fingerprint };
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This package requires a 64-bit Windows 10 or Windows 11 computer.');
  }

  const configuration = classroomConfiguration();
  const projectRoot = await fs.realpath(root);
  const ownership = await acquireOwnership(configuration, projectRoot);
  if (!ownership.owned) {
    await showExistingDemo(ownership.owner);
    return;
  }

  const { owner } = ownership;
  const requestFile = stopRequestFile(owner.launchId);
  const resultFile = stopResultFile(owner.launchId);

  separator();
  console.log('AGENTIC TRADING GAMES - CLASSROOM DEMO');
  separator();
  console.log('Starting the demo. This normally takes only a few seconds...');
  console.log('');

  let app;
  let stopTimer;
  let input;
  let stopping = false;
  let finishedResolve;
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  let cleanupPromise;

  const cleanup = ({ acknowledgeStop = false } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearInterval(stopTimer);
      input?.close();
      let closeError = null;
      if (app) {
        const closingApp = app;
        app = null;
        try {
          await closingApp.close();
        } catch (error) {
          closeError = error;
        }
      }

      if (acknowledgeStop) {
        try {
          await writeJsonAtomically(resultFile, {
            version: 1,
            launchId: owner.launchId,
            success: closeError === null,
            completedAt: new Date().toISOString(),
            error: closeError ? String(closeError.message ?? closeError) : null,
          });
        } catch (error) {
          closeError ??= new Error(`The clean-stop confirmation could not be saved: ${error.message}`);
        }
      }

      await fs.rm(requestFile, { force: true }).catch(() => {});
      const currentOwner = await readJson(ownerFile);
      if (currentOwner?.launchId === owner.launchId) {
        await fs.rm(ownerLockDirectory, { recursive: true, force: true });
      }
      await fs.rmdir(controlDirectory).catch(() => {});
      return closeError;
    })();
    return cleanupPromise;
  };

  const shutdown = async (reason, error = null, acknowledgeStop = false) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log(`Stopping the demo safely (${reason})...`);
    const closeError = await cleanup({ acknowledgeStop });
    const failure = error ?? closeError;
    if (failure) {
      console.error(failure instanceof Error ? failure.message : String(failure));
      console.error('The demo stopped, but a clean save could not be confirmed. Contact the sender.');
      process.exitCode = 1;
    } else {
      console.log('The demo has stopped. All classroom records were saved.');
    }
    finishedResolve();
  };

  try {
    await Promise.all([
      verifyPortIsAvailable(configuration.studentPort, configuration.studentHost),
      verifyPortIsAvailable(configuration.instructorPort, instructorHost),
    ]);
    const encryptionKey = await getOrCreateDataKey();
    const auditKey = await pinAuditPublicKey(encryptionKey);
    const [tlsKey, tlsCert] = await Promise.all([
      fs.readFile(configuration.tlsKeyPath),
      fs.readFile(configuration.tlsCertPath),
    ]);
    app = createApplication({
      databasePath: path.join(appDataRoot, 'data', 'agentic-games.sqlite'),
      encryptionKey,
      studentHost: configuration.studentHost,
      studentPublicOrigin: configuration.studentPublicOrigin,
      studentAllowedCidr: configuration.studentAllowedCidr,
      tls: { key: tlsKey, cert: tlsCert, minVersion: 'TLSv1.2' },
    });
    await listen(app.studentServer, configuration.studentPort, configuration.studentHost);
    await listen(app.instructorServer, configuration.instructorPort, instructorHost);
    const instructorUrl = app.instructorBootstrapUrl();

    stopTimer = setInterval(async () => {
      if (stopping) return;
      const request = await readJson(requestFile);
      if (request?.launchId === owner.launchId) {
        await shutdown('STOP_DEMO.bat was used', null, true);
      }
    }, 250);

    const earlyRequest = await readJson(requestFile);
    if (earlyRequest?.launchId === owner.launchId) {
      await shutdown('STOP_DEMO.bat was used', null, true);
      await finished;
      return;
    }

    if (!(await waitForHealth(configuration, 15_000, () => stopping))) {
      if (stopping) {
        await finished;
        return;
      }
      throw new Error('The demo started but did not pass its health check. Contact the sender and include a picture of this window.');
    }

    await writeJsonAtomically(readyFile, {
      version: 1,
      launchId: owner.launchId,
      readyAt: new Date().toISOString(),
    });

    separator();
    console.log('DEMO READY');
    separator();
    console.log(`Instructor page: ${instructorUrl}`);
    console.log(`Student address: ${configuration.studentPublicOrigin}/`);
    console.log(`Pinned audit public key: ${auditKey.filename}`);
    console.log(`Audit key fingerprint: ${auditKey.fingerprint}`);
    console.log('');
    console.log('KEEP THIS BLACK WINDOW OPEN FOR THE ENTIRE CLASS.');
    console.log('To stop safely, double-click STOP_DEMO.bat in the demo folder.');
    console.log('You can also return to this window and press Enter.');
    separator('-');

    openBrowser(instructorUrl);

    if (process.stdin.isTTY) {
      input = createInterface({ input: process.stdin, output: process.stdout });
      input.once('line', () => { void shutdown('Enter was pressed'); });
    }
    process.once('SIGINT', () => { void shutdown('Ctrl+C was pressed'); });
    process.once('SIGTERM', () => { void shutdown('Windows requested shutdown'); });
    process.once('SIGHUP', () => { void shutdown('the window was closed'); });
    process.once('uncaughtException', (error) => { void shutdown('an unexpected error occurred', error); });
    process.once('unhandledRejection', (error) => { void shutdown('an unexpected error occurred', error); });

    await finished;
  } catch (error) {
    const closeError = await cleanup();
    if (closeError) console.error(`Cleanup also reported: ${closeError.message}`);
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        'A configured classroom or instructor port is already being used by another program. Nothing was stopped. Close the other program, restart Windows, or contact campus IT.',
      );
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  separator();
  console.error('THE DEMO COULD NOT START');
  separator();
  console.error(error instanceof Error ? error.message : String(error));
  console.error('No other program was stopped or changed.');
  console.error('Take a picture of this window and send it to the person who gave you the ZIP file.');
  process.exitCode = 1;
}
