import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuditRandom } from '../src/random.js';

test('audit random is deterministic, resumable, and commit-verifiable', () => {
  const seed = '01'.repeat(32);
  const first = new AuditRandom(seed);
  const second = new AuditRandom(seed);
  const values = Array.from({ length: 12 }, () => first.int(1, 6));
  assert.deepEqual(values, Array.from({ length: 12 }, () => second.int(1, 6)));
  assert.equal(first.commitment(), crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex'));

  const snapshot = first.snapshot();
  const restored = new AuditRandom(snapshot.seedHex, snapshot.counter);
  assert.equal(first.float(), restored.float());
  assert.deepEqual(first.shuffle([1, 2, 3, 4, 5]), restored.shuffle([1, 2, 3, 4, 5]));
});

test('audit random validates unsafe inputs', () => {
  assert.throws(() => new AuditRandom('bad'), /Seed/);
  const rng = new AuditRandom('02'.repeat(32));
  assert.throws(() => rng.int(5, 4), /range/);
  assert.throws(() => rng.choice([]), /empty/);
});
