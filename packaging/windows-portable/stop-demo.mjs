import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { windowsAppDataRoot } from './app-data.mjs';

const controlDirectory = path.join(windowsAppDataRoot(), 'launcher');
const ownerLockDirectory = path.join(controlDirectory, 'owner.lock');
const ownerFile = path.join(ownerLockDirectory, 'owner.json');

function stopRequestFile(launchId) {
  return path.join(controlDirectory, `stop-request-${launchId}.json`);
}

function stopResultFile(launchId) {
  return path.join(controlDirectory, `stop-result-${launchId}.json`);
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch {
    return null;
  }
}

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
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

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function quarantineStaleLock() {
  const quarantine = `${ownerLockDirectory}.stale-${crypto.randomUUID()}`;
  try {
    await fs.rename(ownerLockDirectory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
}

async function cleanupControlFile(filename, launchId) {
  const content = await readJson(filename);
  if (content?.launchId === launchId) await fs.rm(filename, { force: true });
}

async function main() {
  if (!(await pathExists(ownerLockDirectory))) {
    console.log('No running Agentic Trading Games demo was found. It is already stopped.');
    return;
  }

  const owner = await waitForOwner();
  if (!owner?.launchId || !Number.isInteger(owner.pid)) {
    const age = Date.now() - (await fs.stat(ownerLockDirectory)).mtimeMs;
    if (age > 10_000) {
      await quarantineStaleLock();
      console.log('The previous demo was already stopped. Its old launcher lock was cleaned up.');
      return;
    }
    throw new Error('The demo is still beginning to start. Wait a few seconds and use STOP_DEMO again.');
  }

  const requestFile = stopRequestFile(owner.launchId);
  const resultFile = stopResultFile(owner.launchId);
  if (!processIsAlive(owner.pid)) {
    await quarantineStaleLock();
    await cleanupControlFile(requestFile, owner.launchId);
    console.error('The demo process was already stopped, but a clean save could not be confirmed.');
    console.error('Send a picture of this window to the person who provided the ZIP.');
    process.exitCode = 1;
    return;
  }

  const currentOwner = await readJson(ownerFile);
  if (currentOwner?.launchId !== owner.launchId) {
    console.error('The original demo stopped or changed before the stop request was sent.');
    console.error('A clean save could not be confirmed. Use STOP_DEMO again if another demo is running.');
    process.exitCode = 1;
    return;
  }

  try {
    await fs.writeFile(requestFile, JSON.stringify({
      version: 1,
      launchId: owner.launchId,
      requestedAt: new Date().toISOString(),
    }, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      if (error?.code === 'ENOENT') {
        console.error('The demo stopped while the stop request was being sent. A clean save could not be confirmed.');
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  console.log('Stopping the demo safely. Please wait...');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await readJson(resultFile);
    if (result?.launchId === owner.launchId) {
      await cleanupControlFile(resultFile, owner.launchId);
      await cleanupControlFile(requestFile, owner.launchId);
      await fs.rmdir(controlDirectory).catch(() => {});
      if (result.success === true) {
        console.log('The demo stopped successfully. All classroom records were saved.');
      } else {
        console.error('The demo stopped, but a clean save could not be confirmed.');
        if (result.error) console.error(result.error);
        process.exitCode = 1;
      }
      return;
    }

    const latestOwner = await readJson(ownerFile);
    if (latestOwner?.launchId !== owner.launchId || !processIsAlive(owner.pid)) {
      console.error('The demo stopped, but it did not provide a clean-save confirmation.');
      console.error('Send a picture of this window to the person who provided the ZIP.');
      process.exitCode = 1;
      return;
    }
    await delay(250);
  }

  console.error('The demo did not stop within 20 seconds.');
  console.error('Return to the original black demo window and press Enter, or contact the sender.');
  console.error('No process was forcefully ended.');
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('STOP_DEMO could not complete safely.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('No process was forcefully ended. Contact the sender for help.');
  process.exitCode = 1;
}
