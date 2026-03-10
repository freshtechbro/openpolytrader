import type { MetricsStore } from '../../telemetry/metrics.js';

export function recordWebSearchMetric(
  metrics: MetricsStore | undefined,
  event: string,
  data: Record<string, unknown>
): void {
  if (!metrics) return;
  metrics.record({
    type: 'web_search',
    timestamp: Date.now(),
    data: { event, ...data }
  });
}
