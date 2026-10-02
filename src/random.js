import crypto from 'node:crypto';

export class AuditRandom {
  constructor(seedHex = crypto.randomBytes(32).toString('hex'), counter = 0) {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('Seed must be 32-byte hex');
    this.seedHex = seedHex.toLowerCase();
    this.counter = counter;
    this.version = 'sha256-counter-v1';
  }

  commitment() {
    return crypto.createHash('sha256').update(Buffer.from(this.seedHex, 'hex')).digest('hex');
  }

  bytes(length) {
    const chunks = [];
    let remaining = length;
    while (remaining > 0) {
      const counterBuffer = Buffer.alloc(8);
      counterBuffer.writeBigUInt64BE(BigInt(this.counter++));
      const digest = crypto
        .createHash('sha256')
        .update(Buffer.from(this.seedHex, 'hex'))
        .update(counterBuffer)
        .digest();
      const slice = digest.subarray(0, Math.min(remaining, digest.length));
      chunks.push(slice);
      remaining -= slice.length;
    }
    return Buffer.concat(chunks);
  }

  float() {
    const value = this.bytes(6).readUIntBE(0, 6);
    return value / 281474976710656;
  }

  int(min, maxInclusive) {
    if (!Number.isInteger(min) || !Number.isInteger(maxInclusive) || maxInclusive < min) {
      throw new Error('Invalid integer range');
    }
    return min + Math.floor(this.float() * (maxInclusive - min + 1));
  }

  choice(items) {
    if (!items.length) throw new Error('Cannot choose from empty array');
    return items[this.int(0, items.length - 1)];
  }

  weighted(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = this.float() * total;
    for (const entry of entries) {
      threshold -= entry.weight;
      if (threshold <= 0) return entry.value;
    }
    return entries.at(-1).value;
  }

  shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  normal(mean = 0, standardDeviation = 1) {
    const u1 = Math.max(this.float(), Number.EPSILON);
    const u2 = this.float();
    return mean + standardDeviation * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  snapshot() {
    return { seedHex: this.seedHex, counter: this.counter, version: this.version };
  }
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(12).toString('base64url')}`;
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
