import { afterEach, describe, it, expect, vi } from 'vitest';

import { mapWithConcurrency } from '../../src/utils/concurrency.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('mapWithConcurrency', () => {
  it('returns empty array without calling fn when items are empty', async () => {
    const fn = vi.fn(async () => 123);
    const result = await mapWithConcurrency([], 5, fn);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs sequentially when concurrency is 1', async () => {
    vi.useFakeTimers();
    const items = [1, 2, 3, 4];
    let active = 0;
    let maxActive = 0;

    const resultPromise = mapWithConcurrency(items, 1, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(maxActive).toBe(1);
    expect(result).toEqual([2, 4, 6, 8]);
  });

  it('limits parallelism when concurrency is greater than 1', async () => {
    vi.useFakeTimers();
    const items = [1, 2, 3, 4, 5, 6];
    let active = 0;
    let maxActive = 0;

    const resultPromise = mapWithConcurrency(items, 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value + 1;
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('floors invalid concurrency to 1', async () => {
    const result = await mapWithConcurrency([1, 2], 0, async (value) => value);
    expect(result).toEqual([1, 2]);
  });
});
