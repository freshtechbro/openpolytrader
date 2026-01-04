import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricsStore } from './metrics.js';

export function emitAllowlistSnapshot(metrics: MetricsStore, allowlist: MarketAllowlist): void {
  metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: { allowlist: allowlist.list() }
  });
}
