import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';

describe('OpsAgent scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules the next run after checks and clears the timer on stop', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    let resolveCheck: ((value: { ok: boolean }) => void) | null = null;
    let invoked = false;
    const checkPromise = new Promise<{ ok: boolean }>((resolve) => {
      resolveCheck = resolve;
    });

    const agent = new OpsAgent({
      intervalMs: 1000,
      checks: [
        {
          name: 'ok',
          check: async () => {
            invoked = true;
            return checkPromise;
          }
        }
      ]
    });

    agent.start();

    await vi.runAllTicks();

    expect(invoked).toBe(true);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(agent.getReport().lastCheckMs).toBeNull();
    resolveCheck?.({ ok: true });

    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTicks();

    expect(agent.getReport().lastCheckMs).not.toBeNull();
    expect(setTimeoutSpy).toHaveBeenCalled();

    agent.stop();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
