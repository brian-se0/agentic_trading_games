import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export function windowsAppDataRoot(environment = process.env, homeDirectory = os.homedir()) {
  const localAppData = environment.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local');
  return path.join(localAppData, 'Agentic Trading Games');
}

export async function getOrCreateDataKey({ environment = process.env } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI is required to unlock classroom data');
  const keyDirectory = path.join(windowsAppDataRoot(environment), 'keys');
  const keyFile = path.join(keyDirectory, 'database-key.dpapi');
  await fs.mkdir(keyDirectory, { recursive: true });
  const newKey = crypto.randomBytes(32).toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$keyPath = $env:ATG_DPAPI_KEY_FILE
if (-not (Test-Path -LiteralPath $keyPath)) {
  $plain = [Convert]::FromBase64String($env:ATG_NEW_DATA_KEY)
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $temporary = "$keyPath.$PID.tmp"
  [IO.File]::WriteAllBytes($temporary, $protected)
  try { [IO.File]::Move($temporary, $keyPath) }
  catch { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
$stored = [IO.File]::ReadAllBytes($keyPath)
$unprotected = [Security.Cryptography.ProtectedData]::Unprotect(
  $stored, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($unprotected.Length -ne 32) { throw 'The protected database key has an invalid length.' }
[Console]::Out.Write([Convert]::ToBase64String($unprotected))
`;
  const { stdout } = await runFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024,
    env: {
      ...environment,
      ATG_DPAPI_KEY_FILE: keyFile,
      ATG_NEW_DATA_KEY: newKey,
    },
  });
  const encoded = stdout.trim();
  if (Buffer.from(encoded, 'base64').length !== 32) throw new Error('Windows returned an invalid database key');
  return encoded;
}
