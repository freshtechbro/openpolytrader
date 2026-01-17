import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler, type ShutdownDependencies } from '../../src/core/shutdown.js';
import { TradingStateManager } from '../../src/core/TradingStateManager.js';

const buildDeps = (overrides: Partial<ShutdownDependencies> = {}): ShutdownDependencies => {
  const metrics = {
    record: vi.fn(),
    off: vi.fn()
  };

  const deps: ShutdownDependencies = {
    opsAgent: { stop: vi.fn() },
    supervisor: { shutdown: vi.fn().mockResolvedValue(undefined) },
    clob: { cancelAll: vi.fn().mockResolvedValue(undefined) },
    tradingStateManager: new TradingStateManager(true, 'shadow'),
    metrics,
    realtime: { close: vi.fn() },
    store: { close: vi.fn() },
    persistMetric: vi.fn(),
    shutdownTimeoutMs: 10_000,
    exit: vi.fn(),
    setTimeoutFn: vi.fn(() => ({}) as NodeJS.Timeout),
    clearTimeoutFn: vi.fn(),
    clearIntervalFn: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn() }
  };

  return { ...deps, ...overrides };
};

describe('createShutdownHandler', () => {
  it('cancels live orders when runtime trading is live', async () => {
    const tradingStateManager = new TradingStateManager(true, 'live');
    const clob = { cancelAll: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdownHandler(buildDeps({ tradingStateManager, clob }));

    await shutdown('SIGTERM');

    expect(clob.cancelAll).toHaveBeenCalledOnce();
  });

  it('skips cancelAll when runtime trading is not live', async () => {
    const tradingStateManager = new TradingStateManager(true, 'shadow');
    const clob = { cancelAll: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdownHandler(buildDeps({ tradingStateManager, clob }));

    await shutdown('SIGINT');

    expect(clob.cancelAll).not.toHaveBeenCalled();
  });

  it('closes the user realtime channel when provided', async () => {
    const userRealtime = { close: vi.fn() };
    const shutdown = createShutdownHandler(buildDeps({ userRealtime }));

    await shutdown('SIGTERM');

    expect(userRealtime.close).toHaveBeenCalledOnce();
  });

  it('records supervisor shutdown failures', async () => {
    const error = new Error('supervisor failed');
    const supervisor = { shutdown: vi.fn().mockRejectedValue(error) };
    const deps = buildDeps({ supervisor });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_supervisor_failed' })
      })
    );
  });

  it('records cancelAll failures when live trading', async () => {
    const error = new Error('cancel failed');
    const tradingStateManager = new TradingStateManager(true, 'live');
    const clob = { cancelAll: vi.fn().mockRejectedValue(error) };
    const deps = buildDeps({ tradingStateManager, clob });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_cancel_all_failed' })
      })
    );
  });

  it('records ops server close failures', async () => {
    const error = new Error('ops server close failed');
    const opsServer = { close: vi.fn().mockRejectedValue(error) };
    const deps = buildDeps({ opsServer });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_ops_server_failed' })
      })
    );
  });

  it('handles non-Error failures and clears prune timers', async () => {
    const tradingStateManager = new TradingStateManager(true, 'live');
    const supervisor = { shutdown: vi.fn().mockRejectedValue('supervisor-failed') };
    const clob = { cancelAll: vi.fn().mockRejectedValue(123) };
    const opsServer = { close: vi.fn().mockRejectedValue({ reason: 'ops-close' }) };
    const pruneTimer = {} as NodeJS.Timeout;
    const clearIntervalFn = vi.fn();
    const deps = buildDeps({
      tradingStateManager,
      supervisor,
      clob,
      opsServer,
      pruneTimer,
      clearIntervalFn
    });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(clearIntervalFn).toHaveBeenCalledWith(pruneTimer);
    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_supervisor_failed' })
      })
    );
    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_cancel_all_failed' })
      })
    );
    expect(deps.metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'shutdown_ops_server_failed' })
      })
    );
  });

  it('avoids duplicate shutdown work for concurrent calls', async () => {
    let resolveShutdown: () => void;
    const supervisor = {
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveShutdown = resolve;
          })
      )
    };
    const deps = buildDeps({ supervisor });
    const shutdown = createShutdownHandler(deps);

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    expect(supervisor.shutdown).toHaveBeenCalledOnce();

    resolveShutdown();
    await Promise.all([first, second]);
  });

  it('forces exit when shutdown exceeds timeout', async () => {
    const exit = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() };
    const setTimeoutFn = vi.fn((handler: () => void) => {
      handler();
      return {} as NodeJS.Timeout;
    });
    const deps = buildDeps({ exit, logger, setTimeoutFn });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });

  it('uses default timer and logger fallbacks when not provided', async () => {
    const exit = vi.fn();
    const deps = buildDeps({
      exit,
      logger: undefined,
      now: undefined,
      setTimeoutFn: undefined,
      clearTimeoutFn: undefined,
      clearIntervalFn: undefined
    });
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(0);
  });
});
