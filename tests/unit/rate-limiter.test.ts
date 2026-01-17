import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RateLimiter } from '../../src/services/RateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays when exceeding the burst capacity', async () => {
    const limiter = new RateLimiter(2, 1000);

    await limiter.acquire();
    await limiter.acquire();

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
