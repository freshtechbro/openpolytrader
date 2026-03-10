import type { MetricEvent } from '../telemetry/metrics.js';

interface ShutdownMetricsRecorder {
  record: (event: MetricEvent) => void;
}

export function recordShutdownMetric(
  metrics: ShutdownMetricsRecorder,
  type: MetricEvent['type'],
  message: string,
  timestamp: number,
  error?: string,
  extra: Record<string, unknown> = {}
): void {
  const data =
    error === undefined ? { message, ...extra } : { message, error, ...extra };
  metrics.record({
    type,
    timestamp,
    data
  });
}

export async function stopWithMetric(
  task: () => Promise<void>,
  onError: (errorMessage: string) => void
): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return false;
  }
}
