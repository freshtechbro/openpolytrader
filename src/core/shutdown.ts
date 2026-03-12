import type { MetricEvent } from '../telemetry/metrics.js';
import { recordShutdownMetric, stopWithMetric } from './shutdownSupport.js';

export interface ShutdownDependencies {
  learning?: { stop: () => void };
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

type ShutdownRuntimeInput = {
  now: () => number;
  setTimeoutFn: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  clearTimeoutFn: (timeout: NodeJS.Timeout) => void;
  clearIntervalFn: (timeout: NodeJS.Timeout) => void;
  logger: { log: (message: string) => void; error: (message: string) => void };
};

function startShutdownTimeout(
  deps: ShutdownDependencies,
  input: ShutdownRuntimeInput
): NodeJS.Timeout {
  return input.setTimeoutFn(() => {
    input.logger.error(`[shutdown] timeout after ${deps.shutdownTimeoutMs}ms, forcing exit`);
    deps.exit(1);
  }, deps.shutdownTimeoutMs);
}

async function cancelLiveOrdersIfNeeded(
  deps: ShutdownDependencies,
  input: ShutdownRuntimeInput
): Promise<void> {
  if (!deps.tradingStateManager.isLiveTrading()) {
    return;
  }

  const cancelSucceeded = await stopWithMetric(
    () => deps.clob.cancelAll().then(() => undefined),
    (error) => {
      recordShutdownMetric(deps.metrics, 'error', 'shutdown_cancel_all_failed', input.now(), error);
    }
  );
  if (cancelSucceeded) {
    recordShutdownMetric(deps.metrics, 'info', 'shutdown_cancel_all_ok', input.now());
  }
}

async function closeOpsServerIfPresent(
  deps: ShutdownDependencies,
  input: ShutdownRuntimeInput
): Promise<void> {
  if (!deps.opsServer) {
    return;
  }

  await stopWithMetric(() => deps.opsServer!.close(), (error) => {
    recordShutdownMetric(deps.metrics, 'error', 'shutdown_ops_server_failed', input.now(), error);
  });
}

function releaseRuntimeResources(
  deps: ShutdownDependencies,
  input: ShutdownRuntimeInput
): void {
  deps.realtime.close();
  deps.userRealtime?.close();
  if (deps.pruneTimer) {
    input.clearIntervalFn(deps.pruneTimer);
  }
  deps.metrics.off('event', deps.persistMetric);
  deps.store.close();
}

async function executeShutdown(
  signal: string,
  deps: ShutdownDependencies,
  input: ShutdownRuntimeInput
): Promise<void> {
  const startedAt = input.now();
  input.logger.log(`[shutdown] received ${signal}, beginning shutdown`);

  const timeout = startShutdownTimeout(deps, input);

  try {
    deps.learning?.stop();
    deps.opsAgent.stop();
    recordShutdownMetric(deps.metrics, 'info', 'shutdown_started', input.now(), undefined, { signal });

    await stopWithMetric(() => deps.supervisor.shutdown(), (error) => {
      recordShutdownMetric(deps.metrics, 'error', 'shutdown_supervisor_failed', input.now(), error);
    });
    await cancelLiveOrdersIfNeeded(deps, input);
    await closeOpsServerIfPresent(deps, input);
    releaseRuntimeResources(deps, input);

    input.logger.log(`[shutdown] complete in ${input.now() - startedAt}ms`);
    deps.exit(0);
  } finally {
    input.clearTimeoutFn(timeout);
  }
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
    shutdownInFlight = executeShutdown(signal, deps, {
      now,
      setTimeoutFn,
      clearTimeoutFn,
      clearIntervalFn,
      logger
    });

    return shutdownInFlight;
  };
}
