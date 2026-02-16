import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { EventStore } from '../../core/EventStore.js';
import { RiskSizeRecommendationSchema } from '../../domain/llm.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { clamp, clamp01 } from '../../utils/math.js';
import { safeParseJSON } from '../../utils/serialization.js';

export interface RiskAdvisorDeps {
  llmConfig: AppLLMConfig;
  llmClient: { call: (agent: 'RiskAgent', request: LLMRequest) => Promise<LLMCallResult> };
  promptVersion: string;
  policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  eventStore?: EventStore;
  metrics?: MetricsStore;
}

export interface RiskAdvisorInput {
  opportunityId: string;
  marketId: string;
  minSize: number;
  deterministicSize: number;
  constraints: unknown;
  recentInsights?: unknown;
}

export interface RiskAdvisorResult {
  recommendedSizeRaw: number | null;
  clampedSize: number;
  confidence: number;
  reason: string;
  call: LLMCallResult | null;
}

export class RiskAdvisor {
  constructor(private deps: RiskAdvisorDeps) {}

  async recommendSize(input: RiskAdvisorInput, nowMs = Date.now()): Promise<RiskAdvisorResult> {
    const cfg = this.deps.llmConfig;
    const mode = cfg.agents.RiskAgent.mode;

    const deterministicSize = clampNonNegativeFinite(input.deterministicSize);
    const minSize = clampNonNegativeFinite(input.minSize);

    if (!cfg.enabled || mode === 'disabled') {
      return {
        recommendedSizeRaw: null,
        clampedSize: deterministicSize,
        confidence: 0,
        reason: 'disabled',
        call: null
      };
    }

    const boundedMin = Math.min(minSize, deterministicSize);

    const promptEnvelope = {
      task: 'recommend_size',
      inputs: {
        min_size: boundedMin,
        deterministic_size: deterministicSize,
        risk_constraints: input.constraints,
        market_insights: input.recentInsights ?? null
      },
      output: {
        recommended_size: deterministicSize,
        reason: '...',
        confidence: 0.0
      }
    };

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model: cfg.agents.RiskAgent.model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'developer',
          content:
            'Return JSON only, with shape: {"recommended_size":number,"reason":string,"confidence":number}. Use only the provided inputs. Be conservative: recommended_size must be within [min_size, deterministic_size] and default to deterministic_size when uncertain. If constraints conflict or data is missing, return recommended_size=deterministic_size, confidence=0, reason="insufficient_data". Confidence must be between 0 and 1. No prose.'
        },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ]
    };

    const call = await this.deps.llmClient.call('RiskAgent', request);
    const hasOutputText = Boolean(call.outputText);
    const parsed = hasOutputText ? safeParseJSON(call.outputText) : null;
    const validated = hasOutputText
      ? RiskSizeRecommendationSchema.safeParse(parsed)
      : ({ success: false } as const);
    const missingOutput = !hasOutputText;

    const recommendedSizeRaw = validated.success ? validated.data.recommended_size : null;
    const recommended = typeof recommendedSizeRaw === 'number' ? recommendedSizeRaw : Number.NaN;
    const clampedSize = clamp(recommended, boundedMin, deterministicSize, deterministicSize);

    const output = validated.success
      ? {
          recommended_size: clampedSize,
          reason: validated.data.reason,
          confidence: clamp01(validated.data.confidence)
        }
      : {
          recommended_size: deterministicSize,
          reason: missingOutput ? 'missing_output_text' : 'invalid_output',
          confidence: 0
        };
    const violations = missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output'];

    this.persistDecision({
      opportunityId: input.opportunityId,
      mode,
      baseline: { deterministic_size: deterministicSize, min_size: boundedMin, constraints: input.constraints },
      output,
      call,
      request,
      promptEnvelope,
      promptVersion: this.deps.promptVersion,
      policyHashes: this.deps.policyHashes,
      violations,
      nowMs
    });

    if (mode === 'shadow') {
      this.deps.metrics?.record({
        type: 'shadow_decision',
        timestamp: nowMs,
        data: {
          agent: 'RiskAgent',
          opportunityId: input.opportunityId,
          marketId: input.marketId,
          deterministicSize,
          recommendedSizeRaw,
          clampedSize,
          confidence: output.confidence
        }
      });
      return {
        recommendedSizeRaw,
        clampedSize: deterministicSize,
        confidence: output.confidence,
        reason: output.reason,
        call
      };
    }

    return {
      recommendedSizeRaw,
      clampedSize,
      confidence: output.confidence,
      reason: output.reason,
      call
    };
  }

  private persistDecision(args: {
    opportunityId: string;
    mode: 'disabled' | 'shadow' | 'advisory';
    baseline: unknown;
    output: { recommended_size: number; reason: string; confidence: number };
    call: LLMCallResult;
    request?: LLMRequest;
    promptEnvelope: unknown;
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
    violations: string[];
    nowMs: number;
  }): void {
    const request: LLMRequest =
      args.request ??
      ({
        endpoint: 'chat.completions',
        model: this.deps.llmConfig.agents.RiskAgent.model,
        temperature: 0,
        messages: []
      } satisfies LLMRequest);

    logLLMDecision({
      agent: 'RiskAgent',
      mode: args.mode,
      task: 'recommend_size',
      subject: args.opportunityId,
      baseline: args.baseline,
      output: args.output,
      confidence: args.output.confidence,
      applied: args.mode === 'advisory',
      clamp: {
        raw: safeParseJSON(args.call.outputText),
        final: args.output,
        bounds: { recommended_size: ['min_size', 'deterministic_size'] },
        violations: args.violations
      },
      nowMs: args.nowMs,
      call: args.call,
      request,
      promptEnvelopeForHash: args.promptEnvelope,
      contextForHash: args.baseline,
      promptVersion: args.promptVersion,
      policyHashes: args.policyHashes,
      providerFallback: {
        providerId: this.deps.llmConfig.agents.RiskAgent.provider,
        baseUrl: this.deps.llmConfig.providers[this.deps.llmConfig.agents.RiskAgent.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      store: this.deps.eventStore
    });
  }
}

function clampNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}
