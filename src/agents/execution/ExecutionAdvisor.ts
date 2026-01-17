import { messageBus } from '../../core/MessageBus.js';
import { clamp, clamp01 } from '../../utils/math.js';

export interface ExecutionHint {
  timeoutMultiplier: number;
  unwindHint: 'aggressive' | 'neutral' | 'conservative';
  confidence: number;
  expiresAtMs: number;
}

export class ExecutionAdvisor {
  private hintsByMarketId = new Map<string, ExecutionHint>();
  private handler: ((payload: unknown) => void) | null = null;

  constructor(private config: { enabled: boolean }) {
    if (!config.enabled) return;
    this.handler = (payload) => this.handleInsight(payload);
    messageBus.on('learning:insight', this.handler);
  }

  stop(): void {
    if (this.handler) {
      messageBus.off('learning:insight', this.handler);
      this.handler = null;
    }
  }

  getHint(marketId: string, nowMs = Date.now()): ExecutionHint | null {
    const hint = this.hintsByMarketId.get(marketId);
    if (!hint) return null;
    if (nowMs >= hint.expiresAtMs) {
      this.hintsByMarketId.delete(marketId);
      return null;
    }
    return hint;
  }

  private handleInsight(payload: unknown): void {
    const envelope = payload as { insights?: Array<{ market_id?: string; signal?: string; value?: number; ttl_ms?: number; confidence?: number }> };
    if (!Array.isArray(envelope.insights)) return;

    const nowMs = Date.now();
    for (const insight of envelope.insights) {
      const marketId = typeof insight.market_id === 'string' ? insight.market_id : null;
      if (!marketId) continue;
      const ttlMs = typeof insight.ttl_ms === 'number' && Number.isFinite(insight.ttl_ms) ? insight.ttl_ms : 0;
      const value = typeof insight.value === 'number' && Number.isFinite(insight.value) ? insight.value : 0;
      const confidence =
        typeof insight.confidence === 'number' && Number.isFinite(insight.confidence) ? insight.confidence : 0;

      // Conservative-only: timeoutMultiplier must be <= 1 (no longer timeouts).
      // Derive from insight value: higher value => slightly shorter timeouts.
      const timeoutMultiplier = clamp(valueToTimeoutMultiplier(value), 0.8, 1.0, 1.0);
      const unwindHint = value >= 0.75 ? 'aggressive' : value >= 0.4 ? 'neutral' : 'conservative';

      this.hintsByMarketId.set(marketId, {
        timeoutMultiplier,
        unwindHint,
        confidence: clamp01(confidence),
        expiresAtMs: nowMs + Math.max(ttlMs, 1)
      });
    }
  }
}

function valueToTimeoutMultiplier(value: number): number {
  const v = clamp01(value);
  return 1 - 0.2 * v;
}
