import { describe, expect, it } from 'vitest';

import { clamp, clamp01 } from '../../src/utils/math.js';

describe('math utils', () => {
  it('clamps finite values within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('returns fallback when value is not finite', () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10, 0)).toBe(0);
  });

  it('handles swapped bounds and non-finite bounds', () => {
    expect(clamp(5, 10, 0)).toBe(5);
    expect(clamp(Number.NaN, 10, 0)).toBe(10);
    expect(clamp(5, Number.NaN, 2)).toBe(2);
    expect(clamp(5, 2, Number.NaN)).toBe(2);
    expect(clamp(Number.NaN, Number.NaN, 2, Number.NaN)).toBe(2);
  });

  it('clamp01 clamps to [0,1] and defaults non-finite to 0', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
