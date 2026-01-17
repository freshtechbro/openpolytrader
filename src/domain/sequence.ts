export function parseExchangeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  return Number.isFinite(asDate) ? asDate : null;
}

export function isOutOfSequence(prevTimestamp: unknown, nextTimestamp: unknown): boolean {
  const prev = parseExchangeTimestamp(prevTimestamp);
  const next = parseExchangeTimestamp(nextTimestamp);
  if (prev === null || next === null) return false;
  return next < prev;
}

export interface SequenceGap {
  tokenId: string;
  expectedSeq: number;
  receivedSeq: number;
  gapSize: number;
}

export class SequenceTracker {
  private sequences = new Map<string, number>();
  private gaps: SequenceGap[] = [];

  update(tokenId: string, seq: number): SequenceGap | null {
    const prev = this.sequences.get(tokenId);
    this.sequences.set(tokenId, seq);

    if (prev === undefined) {
      return null;
    }

    const expected = prev + 1;
    if (seq !== expected && seq > prev) {
      const gap: SequenceGap = {
        tokenId,
        expectedSeq: expected,
        receivedSeq: seq,
        gapSize: seq - expected
      };
      this.gaps.push(gap);
      if (this.gaps.length > 100) {
        this.gaps.shift();
      }
      return gap;
    }

    return null;
  }

  getSequence(tokenId: string): number | undefined {
    return this.sequences.get(tokenId);
  }

  getRecentGaps(limit = 10): SequenceGap[] {
    return this.gaps.slice(-limit);
  }

  hasGaps(): boolean {
    return this.gaps.length > 0;
  }

  clear(): void {
    this.sequences.clear();
    this.gaps = [];
  }
}

export function computeBookChecksum(
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
  levels = 10
): string {
  const topBids = bids.slice(0, levels);
  const topAsks = asks.slice(0, levels);
  
  const parts: string[] = [];
  for (const bid of topBids) {
    parts.push(`${bid.price}:${bid.size}`);
  }
  parts.push('|');
  for (const ask of topAsks) {
    parts.push(`${ask.price}:${ask.size}`);
  }
  
  const input = parts.join(',');
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
