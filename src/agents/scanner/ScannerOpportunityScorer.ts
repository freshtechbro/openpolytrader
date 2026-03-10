import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { ScannerScoreSchema } from '../../domain/llm.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import {
  callAgentJson,
  logAgentDecision,
  withAgent,
  type AgentLlmConfig
} from '../../services/llm/AgentLlm.js';
import type { LLMRequest } from '../../services/llm/types.js';

export type ScannerInsight = {
  market_id: string;
  signal: string;
  value: number;
  ttl_ms: number;
  confidence: number;
};

export async function scoreScannerOpportunity(input: {
  opportunity: ArbitrageOpportunity;
  insight: ScannerInsight | null;
  nowMs: number;
  mode: NonNullable<AppLLMConfig['agents']['ScannerAgent']>['mode'];
  llm: AgentLlmConfig<'ScannerAgent'>;
  messageBus: MessageBus<RuntimeEventMap>;
  store?: EventStore;
}): Promise<number> {
  const { opportunity, insight, nowMs, mode, llm, messageBus, store } = input;
  const promptEnvelope = {
    task: 'score_market',
    inputs: {
      market_id: opportunity.marketId,
      current_edge: opportunity.edge,
      recent_outcomes: insight
        ? { signal: insight.signal, value: insight.value, confidence: insight.confidence }
        : null,
      book_quality: {
        depth: opportunity.maxSizeByDepth,
        tick_size: Math.max(opportunity.tickSize, 0)
      }
    },
    constraints: { no_trade_decisions: true },
    output: { priority_score: 0.5, rationale: '...', confidence: 0.5 }
  };

  const request: LLMRequest = {
    endpoint: 'chat.completions',
    model: llm.config.agents.ScannerAgent.model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'developer',
        content:
          'Return JSON only, with shape: {"priority_score":number,"rationale":string,"confidence":number}. Do NOT make trade decisions; only rank opportunities. Use only the inputs. Score must be between 0 and 1 and reflect relative priority vs the deterministic edge. recent_outcomes may be null and that is expected; still score using current_edge and book_quality. Only return priority_score=0.5, confidence=0, rationale="insufficient_data" when current_edge or book_quality is missing/invalid and you cannot score safely. Confidence must be between 0 and 1. No prose.'
      },
      { role: 'user', content: JSON.stringify(promptEnvelope) }
    ]
  };

  const context = withAgent('ScannerAgent', llm);
  const { call, parsed, validated, missingOutput, violations } = await callAgentJson(
    context,
    request,
    ScannerScoreSchema
  );
  const output = validated.success
    ? validated.data
    : {
        priority_score: 0.5,
        rationale: missingOutput ? 'missing_output_text' : 'invalid_output',
        confidence: 0
      };

  logAgentDecision(context, {
    mode,
    task: 'score_market',
    subject: opportunity.id,
    baseline: { deterministic_priority: opportunity.edge },
    output,
    confidence: output.confidence,
    applied: mode === 'advisory',
    clamp: {
      raw: parsed,
      final: output,
      bounds: { priority_score: [0, 1] },
      violations
    },
    nowMs,
    call,
    request,
    promptEnvelopeForHash: promptEnvelope,
    contextForHash: { deterministic_priority: opportunity.edge },
    messageBus,
    store
  });

  return output.priority_score;
}
