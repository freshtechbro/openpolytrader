import type { TradePolicy } from '../../config/policy.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { MetricsStore } from '../../telemetry/metrics.js';

export function recordBookParameterMetrics(
  metrics: MetricsStore | undefined,
  tokenId: string,
  previous: OrderBookState | undefined,
  next: OrderBookState,
  receivedAtMs: number,
  rawTickSize: number | null,
  rawMinOrderSize: number | null
): void {
  if (!metrics || (rawTickSize === null && rawMinOrderSize === null)) return;

  const previousTickSize = previous?.tickSize;
  const previousMinOrderSize = previous?.minOrderSize;
  if (previousTickSize === next.tickSize && previousMinOrderSize === next.minOrderSize) return;

  metrics.record({
    type: 'info',
    timestamp: receivedAtMs,
    data: {
      message: 'book_params_updated',
      tokenId,
      rawTickSize,
      rawMinOrderSize,
      previousTickSize,
      previousMinOrderSize,
      resolvedTickSize: next.tickSize,
      resolvedMinOrderSize: next.minOrderSize
    }
  });
}

export function recordFallbackMetrics(
  metrics: MetricsStore | undefined,
  policy: TradePolicy,
  tokenId: string,
  next: OrderBookState,
  receivedAtMs: number,
  usedTickFallback: boolean,
  usedMinOrderFallback: boolean,
  rawTickSize: number | null,
  rawMinOrderSize: number | null
): void {
  if (!metrics || (!usedTickFallback && !usedMinOrderFallback)) return;

  metrics.record({
    type: 'book_fallback',
    timestamp: receivedAtMs,
    data: {
      tokenId,
      usedTickFallback,
      usedMinOrderFallback,
      fallbackTickSize: policy.fallbackTickSize,
      fallbackMinOrderSize: policy.fallbackMinOrderSize,
      rawTickSize,
      rawMinOrderSize,
      resolvedTickSize: next.tickSize,
      resolvedMinOrderSize: next.minOrderSize
    }
  });
}
