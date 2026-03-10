import { describe, expect, it } from 'vitest';

import {
  LearningInsightEventSchema,
  LLMDecisionReasoningV1Schema,
  LLMDecisionRecordV1Schema,
  MarketDataOutlierSchema,
  OpsHealthSummarySchema,
  PortfolioAnomalySchema,
  RiskSizeRecommendationSchema,
  ScannerScoreSchema
} from '../../src/domain/llm.js';
import { extractResponseText } from '../../src/services/llm/extractResponseText.js';

describe('llm runtime contracts', () => {
  it('parses the persisted LLM decision and reasoning schemas', () => {
    const decision = LLMDecisionRecordV1Schema.parse({
      schema_version: 1,
      agent: 'ExecutionAgent',
      mode: 'advisory',
      task: 'smoke_test',
      subject: 'system:smoke',
      baseline: { endpoint: 'chat.completions' },
      output: { ok: true },
      confidence: 0.8,
      applied: false,
      clamp: { raw: { ok: true } },
      ttl_ms: 5000
    });
    const reasoning = LLMDecisionReasoningV1Schema.parse({
      provider: {
        provider_id: 'opencode-zen',
        base_url: 'https://llm.example.com',
        endpoint: 'chat.completions',
        model: 'glm-4.7'
      },
      request_identity: {
        attempt: 1
      },
      timing: {
        started_at_ms: 1_700_000_000_000,
        latency_ms: 250,
        timeout_ms: 12000,
        max_retries: 1
      },
      params: {
        temperature: 0,
        top_p: 1
      },
      hashes: {
        prompt_hash: 'prompt-hash',
        context_hash: 'context-hash',
        prompt_version: 'v1'
      },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      },
      result: {
        status: 'success'
      },
      policy_snapshots: {
        trade_policy_hash: 'trade-hash',
        risk_config_hash: 'risk-hash'
      },
      data_export: {
        included_trade_details: false,
        redaction_applied: true
      }
    });

    expect(decision.agent).toBe('ExecutionAgent');
    expect(reasoning.provider.endpoint).toBe('chat.completions');
    expect(reasoning.result.status).toBe('success');
  });

  it('parses the smaller advisory payload schemas', () => {
    expect(
      LearningInsightEventSchema.parse({
        insights: [
          {
            market_id: 'market-1',
            signal: 'high_confidence',
            value: 0.9,
            ttl_ms: 5000,
            confidence: 0.8,
            source: 'learning',
            kind: 'outcome_summary'
          }
        ],
        generatedAtMs: 1_700_000_000_000
      }).insights
    ).toHaveLength(1);
    expect(ScannerScoreSchema.parse({ priority_score: 0.7, rationale: 'good market', confidence: 0.6 }).priority_score).toBe(0.7);
    expect(RiskSizeRecommendationSchema.parse({ recommended_size: 12, reason: 'bounded', confidence: 0.7 }).recommended_size).toBe(12);
    expect(PortfolioAnomalySchema.parse({ anomaly: false, reason: null, confidence: 0.2 }).anomaly).toBe(false);
    expect(MarketDataOutlierSchema.parse({ outlier: true, reason: 'spike', confidence: 0.9 }).outlier).toBe(true);
    expect(
      OpsHealthSummarySchema.parse({
        risk_level: 'medium',
        alerts: ['lag'],
        summary: 'Feed lag detected.',
        confidence: 0.75
      }).alerts
    ).toEqual(['lag']);
  });

  it('extracts response text from direct fields, nested parts, and root fallbacks', () => {
    expect(extractResponseText({ output_text: ' direct ' })).toBe('direct');
    expect(
      extractResponseText({
        content: [{ text: 'alpha' }, { content: 'beta' }],
        message: { output_text: 'gamma' },
        choices: [{ message: { content: 'delta' } }]
      })
    ).toBe('alpha\nbeta\ngamma\ndelta');
    expect(extractResponseText({ value: 'root text' }, { fallbackToRoot: true })).toBe('root text');
    expect(extractResponseText({})).toBeNull();
  });
});
