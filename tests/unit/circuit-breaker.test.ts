import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../src/core/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  it('opens after threshold failures and recovers after cooldown', async () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker(
      { failureThreshold: 2, cooldownMs: 1000, halfOpenSuccesses: 1 },
      'test'
    );

    await expect(breaker.execute(async () => {
      throw new Error('fail-1');
    })).rejects.toThrow('fail-1');

    await expect(breaker.execute(async () => {
      throw new Error('fail-2');
    })).rejects.toThrow('fail-2');

    expect(breaker.getState()).toBe('open');

    await expect(breaker.execute(async () => 'ok')).rejects.toThrow(
      'Circuit breaker open for test'
    );

    vi.advanceTimersByTime(1000);

    const resultPromise = breaker.execute(async () => 'ok');
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');

    expect(breaker.getState()).toBe('closed');

    vi.useRealTimers();
  });
});
