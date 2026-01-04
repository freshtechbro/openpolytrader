import { describe, expect, it, vi } from 'vitest';

import { RetryPolicy } from '../../src/services/RetryPolicy.js';

describe('RetryPolicy', () => {
  it('retries until success within maxRetries', async () => {
    vi.useFakeTimers();

    const policy = new RetryPolicy({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      retryOn: () => true
    });

    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient');
      }
      return 'ok';
    });

    const assertion = expect(policy.execute(fn)).resolves.toBe('ok');
    await vi.runAllTimersAsync();
    await assertion;
    expect(attempts).toBe(3);

    vi.useRealTimers();
  });

  it('stops retrying when retryOn returns false', async () => {
    vi.useFakeTimers();

    const policy = new RetryPolicy({
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 50,
      retryOn: (error) => (error as Error).message !== 'fatal'
    });

    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw new Error(attempts === 1 ? 'transient' : 'fatal');
    });

    const assertion = expect(policy.execute(fn)).rejects.toThrow('fatal');
    await vi.runAllTimersAsync();
    await assertion;
    expect(attempts).toBe(2);

    vi.useRealTimers();
  });
});
