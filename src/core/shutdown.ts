import type { MetricEvent } from '../telemetry/metrics.js';

export interface ShutdownDependencies {
  opsAgent: { stop: () => void };
  supervisor: { shutdown: () => Promise<void> };
  clob: { cancelAll: () => Promise<unknown> };
  tradingStateManager: { isLiveTrading: () => boolean };
  metrics: {
    record: (event: MetricEvent) => void;
    off: (event: 'event', listener: (event: MetricEvent) => void) => void;
  };
  realtime: { close: () => void };
  userRealtime?: { close: () => void };
  opsServer?: { close: () => Promise<void> } | null;
  store: { close: () => void };
  pruneTimer?: NodeJS.Timeout | null;
  persistMetric: (event: MetricEvent) => void;
  shutdownTimeoutMs: number;
  exit: (code: number) => void;
  now?: () => number;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  clearTimeoutFn?: (timeout: NodeJS.Timeout) => void;
  clearIntervalFn?: (timeout: NodeJS.Timeout) => void;
  logger?: { log: (message: string) => void; error: (message: string) => void };
}

export function createShutdownHandler(deps: ShutdownDependencies): (signal: string) => Promise<void> {
  let shutdownInFlight: Promise<void> | null = null;
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const logger = deps.logger ?? console;

  return async (signal: string): Promise<void> => {
    if (shutdownInFlight) return shutdownInFlight;

    shutdownInFlight = (async () => {
      const startedAt = now();
      logger.log(`[shutdown] received ${signal}, beginning shutdown`);

      const timeout = setTimeoutFn(() => {
        logger.error(`[shutdown] timeout after ${deps.shutdownTimeoutMs}ms, forcing exit`);
        deps.exit(1);
      }, deps.shutdownTimeoutMs);

      try {
        deps.opsAgent.stop();

        deps.metrics.record({
          type: 'info',
          timestamp: now(),
          data: { message: 'shutdown_started', signal }
        });

        try {
          await deps.supervisor.shutdown();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.metrics.record({
            type: 'error',
            timestamp: now(),
            data: { message: 'shutdown_supervisor_failed', error: message }
          });
        }

        if (deps.tradingStateManager.isLiveTrading()) {
          try {
            await deps.clob.cancelAll();
            deps.metrics.record({
              type: 'info',
              timestamp: now(),
              data: { message: 'shutdown_cancel_all_ok' }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.metrics.record({
              type: 'error',
              timestamp: now(),
              data: { message: 'shutdown_cancel_all_failed', error: message }
            });
          }
        }

        deps.realtime.close();
        deps.userRealtime?.close();

        if (deps.opsServer) {
          try {
            await deps.opsServer.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.metrics.record({
              type: 'error',
              timestamp: now(),
              data: { message: 'shutdown_ops_server_failed', error: message }
            });
          }
        }

        if (deps.pruneTimer) clearIntervalFn(deps.pruneTimer);
        deps.metrics.off('event', deps.persistMetric);
        deps.store.close();

        logger.log(`[shutdown] complete in ${now() - startedAt}ms`);
        deps.exit(0);
      } finally {
        clearTimeoutFn(timeout);
      }
    })();

    return shutdownInFlight;
  };
}
