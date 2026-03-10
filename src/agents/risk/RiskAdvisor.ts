import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { RiskSizeRecommendationSchema } from '../../domain/llm.js';
import {
  callAgentJson,
  logAgentDecision,
  withAgent,
  type AgentLlmConfig,
  type AgentLlmContext,
  type AgentPolicyHashes
} from '../../services/llm/AgentLlm.js';
import type { LLMCallResult, LLMClientPort, LLMRequest } from '../../services/llm/types.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { clamp, clamp01 } from '../../utils/math.js';

interface RiskAdvisorDeps extends Partial<AgentLlmConfig<'RiskAgent'>> {
  llmConfig?: AppLLMConfig;
  llmClient?: LLMClientPort<'RiskAgent'>;
  messageBus?: MessageBus<RuntimeEventMap>;
  store?: EventStore;
  eventStore?: EventStore;
  metrics?: MetricsStore;
}

interface RiskAdvisorInput {
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
    const cfg = this.resolveLlmConfig();
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

    const llm = withAgent('RiskAgent', {
      config: cfg,
      client: this.resolveLlmClient(),
      promptVersion: this.resolvePromptVersion(),
      policyHashes: this.resolvePolicyHashes()
    });
    const { call, parsed, validated, missingOutput, violations } = await callAgentJson(
      llm,
      request,
      RiskSizeRecommendationSchema
    );

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
    this.persistDecision({
      llm,
      opportunityId: input.opportunityId,
      mode,
      baseline: { deterministic_size: deterministicSize, min_size: boundedMin, constraints: input.constraints },
      output,
      call,
      parsed,
      request,
      promptEnvelope,
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
    llm?: AgentLlmContext<'RiskAgent'>;
    opportunityId: string;
    mode: 'disabled' | 'shadow' | 'advisory';
    baseline: unknown;
    output: { recommended_size: number; reason: string; confidence: number };
    call: LLMCallResult;
    parsed?: unknown;
    request?: LLMRequest;
    promptEnvelope: unknown;
    promptVersion?: string;
    policyHashes?: AgentPolicyHashes;
    violations?: string[];
    nowMs: number;
  }): void {
    const llm =
      args.llm ??
      withAgent('RiskAgent', {
        config: this.resolveLlmConfig(),
        client: this.resolveLlmClient(),
        promptVersion: args.promptVersion ?? this.resolvePromptVersion(),
        policyHashes: args.policyHashes ?? this.resolvePolicyHashes()
      });
    const request: LLMRequest =
      args.request ??
      ({
        endpoint: 'chat.completions',
        model: llm.config.agents.RiskAgent.model,
        temperature: 0,
        messages: []
      } satisfies LLMRequest);

    logAgentDecision(llm, {
      mode: args.mode,
      task: 'recommend_size',
      subject: args.opportunityId,
      baseline: args.baseline,
      output: args.output,
      confidence: args.output.confidence,
      applied: args.mode === 'advisory',
      clamp: {
        raw: args.parsed,
        final: args.output,
        bounds: { recommended_size: ['min_size', 'deterministic_size'] },
        violations: args.violations ?? []
      },
      nowMs: args.nowMs,
      call: args.call,
      request,
      promptEnvelopeForHash: args.promptEnvelope,
      contextForHash: args.baseline,
      messageBus: this.deps.messageBus,
      store: this.resolveStore()
    });
  }

  private resolveLlmConfig(): AppLLMConfig {
    const config = this.deps.config ?? this.deps.llmConfig;
    if (!config) {
      throw new Error('RiskAdvisor requires config');
    }
    return config;
  }

  private resolveLlmClient(): LLMClientPort<'RiskAgent'> {
    const client = this.deps.client ?? this.deps.llmClient;
    if (!client) {
      throw new Error('RiskAdvisor requires client');
    }
    return client;
  }

  private resolveStore(): EventStore | undefined {
    return this.deps.store ?? this.deps.eventStore;
  }

  private resolvePromptVersion(): string {
    if (!this.deps.promptVersion) {
      throw new Error('RiskAdvisor requires promptVersion');
    }
    return this.deps.promptVersion;
  }

  private resolvePolicyHashes(): AgentPolicyHashes {
    if (!this.deps.policyHashes) {
      throw new Error('RiskAdvisor requires policyHashes');
    }
    return this.deps.policyHashes;
  }
}

function clampNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}
