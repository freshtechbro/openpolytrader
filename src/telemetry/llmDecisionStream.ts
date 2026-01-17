import type { MetricsStore } from './metrics.js';
import { messageBus } from '../core/MessageBus.js';
import type { LLMDecisionEventPayload } from '../domain/llm.js';

export function attachLLMDecisionStream(metrics: MetricsStore): () => void {
  const handler = (payload: unknown) => {
    const decisionPayload = payload as LLMDecisionEventPayload;
    const timestamp =
      decisionPayload && typeof decisionPayload.at_ms === 'number' ? decisionPayload.at_ms : Date.now();
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
