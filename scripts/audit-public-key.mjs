import crypto from 'node:crypto';
import { auditPublicKeyFromDataKey } from '../src/db.js';

try {
  const publicKey = auditPublicKeyFromDataKey(process.env.AGENTIC_DATA_KEY);
  const keyObject = crypto.createPublicKey(publicKey);
  const fingerprint = crypto.createHash('sha256')
    .update(keyObject.export({ format: 'der', type: 'spki' })).digest('hex');
  process.stderr.write(`Audit signing-key fingerprint: ${fingerprint}\n`);
  process.stdout.write(publicKey);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Set AGENTIC_DATA_KEY from the installation secret manager, then pin this public key before class.');
  process.exitCode = 1;
}
