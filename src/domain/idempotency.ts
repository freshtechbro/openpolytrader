import { createHash } from 'node:crypto';

export function createIdempotencyKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}
