import { createHash } from 'node:crypto';

export interface IdempotencyRecord {
  key: string;
  orderId?: string;
  nonce: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export function createIdempotencyKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}
