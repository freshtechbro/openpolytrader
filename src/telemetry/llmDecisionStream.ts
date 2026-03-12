import type { MetricsStore } from './metrics.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import type { LLMDecisionEventPayload } from '../domain/llm.js';

export function attachLLMDecisionStream(
  metrics: MetricsStore,
  messageBus: MessageBus<RuntimeEventMap>
): () => void {
  const handler = (decisionPayload: LLMDecisionEventPayload) => {
    const timestamp = typeof decisionPayload.at_ms === 'number' ? decisionPayload.at_ms : Date.now();
    metrics.record({
      type: 'llm_decision',
      timestamp,
      data: decisionPayload
    });
  };

  messageBus.on('llm:decision', handler);

  return () => {
    messageBus.off('llm:decision', handler);
  };
}
