import { describe, it, expect } from 'vitest';
import {
  parseExchangeTimestamp,
  isOutOfSequence
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
