import type { TradingMode } from '../config/env.js';
import { EventStore } from '../core/EventStore.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import { type MetricEvent, MetricsStore } from '../telemetry/metrics.js';
import { attachLLMDecisionStream } from '../telemetry/llmDecisionStream.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface BootTelemetry {
  store: EventStore;
  metrics: MetricsStore;
  persistMetric: (event: MetricEvent) => void;
  pruneTimer: ReturnType<typeof setInterval> | null;
  recordPaperRunMarker: (phase: 'start' | 'stop', reason: string) => void;
}

export function createBootTelemetry(input: {
  dbPath: string;
  metricsMaxEvents: number;
  metricsRetentionDays: number;
  metricsPruneIntervalMs: number;
  tradingMode: TradingMode;
  messageBus: MessageBus<RuntimeEventMap>;
}): BootTelemetry {
  const store = new EventStore({ dbPath: input.dbPath });
  const metrics = new MetricsStore(input.metricsMaxEvents);
  const persistMetric = (event: MetricEvent) => store.persistMetric(event);
  metrics.on('event', persistMetric);
  attachLLMDecisionStream(metrics, input.messageBus);

  const paperRunId = input.tradingMode === 'paper' ? `paper-${Date.now()}` : null;
  let paperRunStopMarkerRecorded = false;
  const recordPaperRunMarker = (phase: 'start' | 'stop', reason: string): void => {
    if (!paperRunId) return;
    if (phase === 'stop' && paperRunStopMarkerRecorded) return;
    metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: {
        message: 'paper_run_marker',
        phase,
        runId: paperRunId,
        reason,
        mode: input.tradingMode,
        dbPath: input.dbPath
      }
    });
    if (phase === 'stop') {
      paperRunStopMarkerRecorded = true;
    }
  };

  const pruneMetrics = () => {
    const now = Date.now();
    const cutoff = now - input.metricsRetentionDays * MS_PER_DAY;
    const pruned = store.pruneMetrics(cutoff);
    if (pruned > 0) {
      metrics.record({
        type: 'info',
        timestamp: now,
        data: { message: 'metrics_pruned', pruned, retentionDays: input.metricsRetentionDays }
      });
    }
  };

  pruneMetrics();
  const pruneTimer =
    input.metricsPruneIntervalMs > 0 ? setInterval(pruneMetrics, input.metricsPruneIntervalMs) : null;

  return {
    store,
    metrics,
    persistMetric,
    pruneTimer,
    recordPaperRunMarker
  };
}
