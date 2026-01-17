import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseExchangeTimestamp,
  isOutOfSequence,
  SequenceTracker,
  computeBookChecksum
} from '../../src/domain/sequence.js';

describe('parseExchangeTimestamp', () => {
  it('returns null for non-string input', () => {
    expect(parseExchangeTimestamp(null)).toBeNull();
    expect(parseExchangeTimestamp(undefined)).toBeNull();
    expect(parseExchangeTimestamp(123)).toBeNull();
    expect(parseExchangeTimestamp({})).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseExchangeTimestamp('')).toBeNull();
  });

  it('parses numeric string as timestamp', () => {
    expect(parseExchangeTimestamp('1704067200000')).toBe(1704067200000);
  });

  it('parses ISO date string', () => {
    const result = parseExchangeTimestamp('2024-01-01T00:00:00Z');
    expect(result).toBe(Date.parse('2024-01-01T00:00:00Z'));
  });

  it('returns null for invalid date string', () => {
    expect(parseExchangeTimestamp('not-a-date')).toBeNull();
  });
});

describe('isOutOfSequence', () => {
  it('returns false when prev is null', () => {
    expect(isOutOfSequence(null, '1000')).toBe(false);
  });

  it('returns false when next is null', () => {
    expect(isOutOfSequence('1000', null)).toBe(false);
  });

  it('returns false when next >= prev (in order)', () => {
    expect(isOutOfSequence('1000', '1001')).toBe(false);
    expect(isOutOfSequence('1000', '1000')).toBe(false);
  });

  it('returns true when next < prev (out of order)', () => {
    expect(isOutOfSequence('1001', '1000')).toBe(true);
  });
});

describe('SequenceTracker', () => {
  let tracker: SequenceTracker;

  beforeEach(() => {
    tracker = new SequenceTracker();
  });

  describe('update', () => {
    it('returns null on first update for a tokenId', () => {
      const gap = tracker.update('token1', 100);
      expect(gap).toBeNull();
    });

    it('returns null when sequence increments by 1', () => {
      tracker.update('token1', 100);
      const gap = tracker.update('token1', 101);
      expect(gap).toBeNull();
    });

    it('detects gap when sequence skips', () => {
      tracker.update('token1', 100);
      const gap = tracker.update('token1', 105);
      
      expect(gap).toEqual({
        tokenId: 'token1',
        expectedSeq: 101,
        receivedSeq: 105,
        gapSize: 4
      });
    });

    it('returns null for out-of-order (older) sequences', () => {
      tracker.update('token1', 100);
      const gap = tracker.update('token1', 99);
      expect(gap).toBeNull();
    });

    it('tracks multiple tokenIds independently', () => {
      tracker.update('token1', 100);
      tracker.update('token2', 200);
      
      const gap1 = tracker.update('token1', 105);
      const gap2 = tracker.update('token2', 201);
      
      expect(gap1?.gapSize).toBe(4);
      expect(gap2).toBeNull();
    });

    it('limits stored gaps to 100', () => {
      tracker.update('token1', 0);
      
      for (let i = 1; i <= 110; i++) {
        tracker.update('token1', i * 10);
      }
      
      const gaps = tracker.getRecentGaps(200);
      expect(gaps.length).toBe(100);
    });
  });

  describe('getSequence', () => {
    it('returns undefined for unknown tokenId', () => {
      expect(tracker.getSequence('unknown')).toBeUndefined();
    });

    it('returns last sequence for known tokenId', () => {
      tracker.update('token1', 100);
      tracker.update('token1', 101);
      expect(tracker.getSequence('token1')).toBe(101);
    });
  });

  describe('getRecentGaps', () => {
    it('returns empty array when no gaps', () => {
      expect(tracker.getRecentGaps()).toEqual([]);
    });

    it('returns limited number of gaps', () => {
      tracker.update('token1', 0);
      tracker.update('token1', 10);
      tracker.update('token1', 20);
      tracker.update('token1', 30);
      
      const gaps = tracker.getRecentGaps(2);
      expect(gaps.length).toBe(2);
      expect(gaps[0].receivedSeq).toBe(20);
      expect(gaps[1].receivedSeq).toBe(30);
    });
  });

  describe('hasGaps', () => {
    it('returns false when no gaps detected', () => {
      tracker.update('token1', 100);
      tracker.update('token1', 101);
      expect(tracker.hasGaps()).toBe(false);
    });

    it('returns true when gaps detected', () => {
      tracker.update('token1', 100);
      tracker.update('token1', 110);
      expect(tracker.hasGaps()).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears all sequences and gaps', () => {
      tracker.update('token1', 100);
      tracker.update('token1', 110);
      
      tracker.clear();
      
      expect(tracker.getSequence('token1')).toBeUndefined();
      expect(tracker.hasGaps()).toBe(false);
    });
  });
});

describe('computeBookChecksum', () => {
  it('computes consistent hash for same orderbook', () => {
    const bids = [{ price: 0.50, size: 100 }, { price: 0.49, size: 200 }];
    const asks = [{ price: 0.51, size: 150 }, { price: 0.52, size: 250 }];
    
    const hash1 = computeBookChecksum(bids, asks);
    const hash2 = computeBookChecksum(bids, asks);
    
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different orderbooks', () => {
    const bids1 = [{ price: 0.50, size: 100 }];
    const asks1 = [{ price: 0.51, size: 150 }];
    
    const bids2 = [{ price: 0.50, size: 101 }];
    const asks2 = [{ price: 0.51, size: 150 }];
    
    const hash1 = computeBookChecksum(bids1, asks1);
    const hash2 = computeBookChecksum(bids2, asks2);
    
    expect(hash1).not.toBe(hash2);
  });

  it('respects levels parameter', () => {
    const bids = [
      { price: 0.50, size: 100 },
      { price: 0.49, size: 200 },
      { price: 0.48, size: 300 }
    ];
    const asks = [{ price: 0.51, size: 150 }];
    
    const hash1 = computeBookChecksum(bids, asks, 1);
    const hash2 = computeBookChecksum(bids, asks, 3);
    
    expect(hash1).not.toBe(hash2);
  });

  it('returns 8-character hex string', () => {
    const bids = [{ price: 0.50, size: 100 }];
    const asks = [{ price: 0.51, size: 150 }];
    
    const hash = computeBookChecksum(bids, asks);
    
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles empty orderbook', () => {
    const hash = computeBookChecksum([], []);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
