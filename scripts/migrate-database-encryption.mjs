import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacyDatabaseEncryption } from '../src/db.js';

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  const filename = args[1];
  const valid = args.length === 2 && args[0] === '--trusted-offline-source' &&
    filename && path.isAbsolute(filename);
  if (!valid) {
    console.error(`Usage: AGENTIC_DATA_KEY=<installation-key> node ${path.relative(process.cwd(), scriptPath)} ` +
      '--trusted-offline-source /absolute/path/to/database.sqlite');
    console.error('Stop the application first. Run this only on a verified, untampered v1 or plaintext legacy database.');
    process.exitCode = 2;
  } else {
    try {
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        throw new Error('The database path does not name an existing regular file');
      }
      const result = migrateLegacyDatabaseEncryption(filename, {
        encryptionKey: process.env.AGENTIC_DATA_KEY,
      });
      console.log(result.migrated
        ? `Migrated ${filename} transactionally to row-bound enc:v${result.envelopeVersion} with keyed row/set/schema integrity`
        : `${filename} already uses authenticated row-bound enc:v${result.envelopeVersion} with keyed row/set/schema integrity`);
    } catch (error) {
      console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
