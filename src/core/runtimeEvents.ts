import type { z } from 'zod';

import {
  type LLMCallErrorInfo,
  LearningInsightEventSchema,
  OpsHealthSummarySchema,
  type LLMDecisionEventPayload
} from '../domain/llm.js';
import type { ArbitrageOpportunity } from '../domain/opportunity.js';
import type { OrderBookState } from '../domain/orderbook.js';

export type LearningInsightEvent = z.infer<typeof LearningInsightEventSchema>;
type OpsHealthSummaryEvent = z.infer<typeof OpsHealthSummarySchema> & { generatedAtMs: number };

export interface MarketUpdateEvent {
  tokenId: string;
  book: OrderBookState;
}

export interface RuntimeEventMap {
  [event: string]: unknown;
  'market:updated': MarketUpdateEvent;
  'opportunity:detected': { opportunity: ArbitrageOpportunity };
  'risk:approved': { opportunity: ArbitrageOpportunity; size: number };
  'execution:outcome': {
    marketId: string;
    opportunityId: string;
    executionId?: string;
    idempotencyKey?: string;
    status: string;
    reason?: string;
    at_ms: number;
  };
  'execution:fill': {
    orderId: string;
    marketId?: string;
    tokenId: string;
    side: string;
    size: number;
    price: number;
    expectedPrice?: number;
    slippage?: number;
    at_ms: number;
  };
  'learning:update': {
    at_ms: number;
    markets_tracked: number;
  };
  'learning:insight': LearningInsightEvent;
  'llm:decision': LLMDecisionEventPayload;
  'ops:health': unknown;
  'ops:health_summary': OpsHealthSummaryEvent;
  'ops:alert': unknown;
  'llm:error': {
    agent: string;
    provider_id: string;
    endpoint: string;
    model: string;
    error: LLMCallErrorInfo;
    at_ms: number;
  };
  'marketdata:outlier': {
    tokenId: string;
    outlier: unknown;
    at_ms: number;
  };
}
