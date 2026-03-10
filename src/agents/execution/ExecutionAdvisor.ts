import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { clamp, clamp01 } from '../../utils/math.js';

interface ExecutionHint {
  timeoutMultiplier: number;
  unwindHint: 'aggressive' | 'neutral' | 'conservative';
  confidence: number;
  expiresAtMs: number;
}

export class ExecutionAdvisor {
  private hintsByMarketId = new Map<string, ExecutionHint>();
  private handler: ((payload: RuntimeEventMap['learning:insight']) => void) | null = null;
  private messageBus: MessageBus<RuntimeEventMap>;

  constructor(private config: { enabled: boolean; messageBus?: MessageBus<RuntimeEventMap> }) {
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config.messageBus, 'ExecutionAdvisor');
    if (!config.enabled) return;
    this.handler = (payload) => this.handleInsight(payload);
    this.messageBus.on('learning:insight', this.handler);
  }

  stop(): void {
    if (this.handler) {
      this.messageBus.off('learning:insight', this.handler);
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

  private handleInsight(payload: RuntimeEventMap['learning:insight']): void {
    const nowMs = Date.now();
    const insights = Array.isArray(payload.insights) ? payload.insights : [];
    for (const insight of insights) {
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
