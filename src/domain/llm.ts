import { z } from 'zod';

import type { LLMAgentId, LLMProviderId, LLMEndpoint } from '../services/llm/types.js';

export const LLMProviderIdSchema = z.enum(['opencode-zen', 'openrouter']);
export const LLMAgentIdSchema = z.enum([
  'ExecutionAgent',
  'RiskAgent',
  'ScannerAgent',
  'LearningAgent',
  'PortfolioAgent',
  'MarketDataAgent',
  'OpsAgent'
]);

export const LLMModeSchema = z.enum(['disabled', 'shadow', 'advisory', 'active']);
export const LLMEndpointSchema = z.enum(['chat.completions', 'responses', 'messages']);

export const LLMDecisionClampSchema = z
  .object({
    raw: z.unknown().optional(),
    final: z.unknown().optional(),
    bounds: z.unknown().optional(),
    violations: z.array(z.string()).optional()
  })
  .strict();

export const LLMDecisionRecordV1Schema = z
  .object({
    schema_version: z.literal(1),
    agent: LLMAgentIdSchema,
    mode: LLMModeSchema,
    task: z.string().min(1),
    subject: z.string().min(1),
    baseline: z.unknown(),
    output: z.unknown(),
    confidence: z.number().min(0).max(1),
    applied: z.boolean(),
    clamp: LLMDecisionClampSchema,
    ttl_ms: z.number().int().positive().optional()
  })
  .strict();

export type LLMDecisionRecordV1 = z.infer<typeof LLMDecisionRecordV1Schema>;

export const LLMDecisionReasoningV1Schema = z
  .object({
    provider: z
      .object({
        provider_id: LLMProviderIdSchema,
        base_url: z.string().min(1),
        endpoint: LLMEndpointSchema,
        model: z.string().min(1)
      })
      .strict(),
    request_identity: z
      .object({
        request_id_header: z.string().optional(),
        request_id_body: z.string().optional(),
        response_id: z.string().optional(),
        correlation_id: z.string().optional(),
        attempt: z.number().int().min(0),
        fallback_reason: z.string().optional()
      })
      .strict(),
    timing: z
      .object({
        started_at_ms: z.number().int().nonnegative(),
        latency_ms: z.number().int().nonnegative(),
        timeout_ms: z.number().int().positive(),
        max_retries: z.number().int().min(0)
      })
      .strict(),
    params: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        max_output_tokens: z.number().int().positive().optional(),
        response_format: z.unknown().optional()
      })
      .strict(),
    hashes: z
      .object({
        prompt_hash: z.string().min(1),
        context_hash: z.string().min(1),
        prompt_version: z.string().min(1)
      })
      .strict(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    result: z
      .object({
        status: z.enum(['success', 'fallback', 'timeout', 'error']),
        error: z
          .object({
            type: z.string().min(1),
            status: z.number().int().optional(),
            message: z.string().min(1)
          })
          .strict()
          .optional()
      })
      .strict(),
    policy_snapshots: z
      .object({
        trade_policy_hash: z.string().min(1),
        risk_config_hash: z.string().min(1)
      })
      .strict(),
    data_export: z
      .object({
        included_trade_details: z.boolean(),
        redaction_applied: z.boolean()
      })
      .strict()
  })
  .strict();

export type LLMDecisionReasoningV1 = z.infer<typeof LLMDecisionReasoningV1Schema>;

export const LearningInsightSchema = z
  .object({
    market_id: z.string().min(1),
    signal: z.enum(['high_confidence', 'medium_confidence', 'low_confidence', 'neutral']),
    value: z.number().min(0).max(1),
    ttl_ms: z.number().int().positive(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const LearningInsightEventSchema = z
  .object({
    insights: z.array(LearningInsightSchema),
    generatedAtMs: z.number().int().nonnegative()
  })
  .strict();

export type LearningInsightEvent = z.infer<typeof LearningInsightEventSchema>;

export const ScannerScoreSchema = z
  .object({
    priority_score: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const RiskSizeRecommendationSchema = z
  .object({
    recommended_size: z.number().finite(),
    reason: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const ExecutionHintSchema = z
  .object({
    timeout_multiplier: z.number().min(0.1).max(2),
    unwind_hint: z.enum(['aggressive', 'neutral', 'conservative']),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const PortfolioAnomalySchema = z
  .object({
    anomaly: z.boolean(),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    reason: z.string().nullable(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const MarketDataOutlierSchema = z
  .object({
    outlier: z.boolean(),
    reason: z.string().nullable(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const OpsHealthSummarySchema = z
  .object({
    risk_level: z.enum(['low', 'medium', 'high']),
    alerts: z.array(z.string()),
    summary: z.string().min(1).max(1000),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export interface LLMDecisionEventPayload {
  decision: LLMDecisionRecordV1;
  reasoning: LLMDecisionReasoningV1;
  raw_text?: string;
  at_ms?: number;
}

export interface LLMErrorEventPayload {
  agent: LLMAgentId;
  provider_id: LLMProviderId;
  endpoint: LLMEndpoint;
  model: string;
  error: { type: string; status?: number; message: string };
  at_ms: number;
}

export type LearningUpdateEventPayload = {
  at_ms: number;
  markets_tracked: number;
};
