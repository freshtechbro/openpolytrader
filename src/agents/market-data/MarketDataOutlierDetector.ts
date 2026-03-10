import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { MarketDataOutlierSchema } from '../../domain/llm.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import {
  callAgentJson,
  logAgentDecision,
  withAgent,
  type AgentLlmConfig
} from '../../services/llm/AgentLlm.js';
import type { LLMRequest } from '../../services/llm/types.js';

type MarketDataOutlierLlmConfig = AgentLlmConfig<'MarketDataAgent'>;

export async function detectMarketDataOutlier(input: {
  tokenId: string;
  book: OrderBookState;
  nowMs: number;
  llm: MarketDataOutlierLlmConfig;
  messageBus: MessageBus<RuntimeEventMap>;
  store?: EventStore;
}): Promise<void> {
  const { tokenId, book, nowMs, llm, messageBus, store } = input;
  const bestBid = book.bestBid?.price ?? null;
  const bestAsk = book.bestAsk?.price ?? null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

  const promptEnvelope = {
    task: 'detect_outlier',
    inputs: {
      orderbook: {
        mid_price: mid,
        spread,
        top_bid: bestBid,
        top_ask: bestAsk,
        depth_top: book.bestAsk?.size ?? null,
        timestamp: book.exchangeTimestamp ?? null
      }
    },
    output: { outlier: false, reason: null, confidence: 0.0 }
  };

  const request: LLMRequest = {
    endpoint: 'chat.completions',
    model: llm.config.agents.MarketDataAgent.model,
    messages: [
      {
        role: 'developer',
        content:
          'Return JSON only, with shape: {"outlier":boolean,"reason":string|null,"confidence":number}. Use only the inputs. If best bid/ask or spread is missing, return outlier=false, reason=null, confidence=0. Only flag outlier=true for extreme or clearly inconsistent prices/spreads. Confidence must be between 0 and 1. No prose.'
      },
      { role: 'user', content: JSON.stringify(promptEnvelope) }
    ],
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' }
  };

  const context = withAgent('MarketDataAgent', llm);
  const { call, parsed, validated, missingOutput, violations } = await callAgentJson(
    context,
    request,
    MarketDataOutlierSchema
  );
  const output = missingOutput
    ? { error: 'missing_output_text', status: call.status, llm_error: call.error ?? null }
    : validated.success
      ? validated.data
      : { error: 'invalid_output' };
  const applied = validated.success && validated.data.outlier;
  const confidence = validated.success ? validated.data.confidence : 0;

  if (applied) {
    messageBus.emit('marketdata:outlier', { tokenId, outlier: validated.data, at_ms: nowMs });
  }

  logAgentDecision(context, {
    mode: llm.config.agents.MarketDataAgent.mode,
    task: 'detect_outlier',
    subject: tokenId,
    baseline: promptEnvelope.inputs,
    output,
    confidence,
    applied,
    clamp: { raw: parsed, final: validated.success ? validated.data : undefined, violations },
    nowMs,
    call,
    request,
    promptEnvelopeForHash: promptEnvelope,
    contextForHash: promptEnvelope.inputs,
    messageBus,
    store
  });
}
