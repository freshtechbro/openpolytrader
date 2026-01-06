import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, CircuitBreakerRegistry } from '../../src/core/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  it('opens after threshold failures and recovers after cooldown', async () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker(
      { failureThreshold: 2, cooldownMs: 1000, halfOpenSuccesses: 1 },
      'test'
    );

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');

    await expect(breaker.execute(async () => {
      throw new Error('fail-1');
    })).rejects.toThrow('fail-1');

    await expect(breaker.execute(async () => {
      throw new Error('fail-2');
    })).rejects.toThrow('fail-2');

    expect(breaker.getState()).toBe('open');
    expect(breaker.getFailureCount()).toBe(2);

    await expect(breaker.execute(async () => 'ok')).rejects.toThrow(
      'Circuit breaker open for test'
    );

    vi.advanceTimersByTime(1000);

    const resultPromise = breaker.execute(async () => 'ok');
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');

    expect(breaker.getState()).toBe('closed');

    breaker.recordFailure();
    expect(breaker.getFailureCount()).toBe(1);
    breaker.reset();
    expect(breaker.getFailureCount()).toBe(0);

    vi.useRealTimers();
  });

  it('stays half-open until required successes are reached', () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker(
      { failureThreshold: 1, cooldownMs: 1000, halfOpenSuccesses: 2 },
      'test'
    );

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(1000);
    expect(breaker.getState()).toBe('half-open');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('half-open');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');

    vi.useRealTimers();
  });
});

describe('CircuitBreakerRegistry', () => {
  it('tracks per-market breakers and recovers after cooldown', () => {
    vi.useFakeTimers();

    const registry = new CircuitBreakerRegistry(
      { failureThreshold: 2, cooldownMs: 1000, halfOpenSuccesses: 1 },
      'market'
    );

    registry.recordFailure('market-1');
    expect(registry.isOpen('market-1')).toBe(false);

    registry.recordFailure('market-1');
    expect(registry.isOpen('market-1')).toBe(true);
    expect(registry.getOpenMarkets()).toEqual(['market-1']);
    expect(registry.getSummary().get('market-1')?.failures).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(registry.isOpen('market-1')).toBe(false);

    registry.recordSuccess('market-1');
    expect(registry.get('market-1').getState()).toBe('closed');

    vi.useRealTimers();
  });

  it('only returns markets that are currently open', () => {
    const registry = new CircuitBreakerRegistry(
      { failureThreshold: 1, cooldownMs: 1000, halfOpenSuccesses: 1 },
      'market'
    );

    registry.recordFailure('market-1');
    registry.recordSuccess('market-2');

    expect(registry.getOpenMarkets()).toEqual(['market-1']);
  });
});
