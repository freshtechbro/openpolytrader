import { z } from 'zod';

import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import {
  clampDependencyConfidence,
  dependencyEdgeKey,
  type DependencyEdge,
  type DependencyMarketInput,
  withSortedMarkets
} from '../../domain/dependency.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMClientPort, LLMRequest } from '../../services/llm/types.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { safeParseJSON } from '../../utils/serialization.js';

const DependencyRelationSchema = z.enum([
  'mutual_exclusive',
  'implies',
  'complementary',
  'partition'
]);

const RawDependencyEdgeSchema = z
  .object({
    marketA: z.string().trim().min(1),
    marketB: z.string().trim().min(1),
    relationType: DependencyRelationSchema,
    confidence: z.number().finite(),
    evidence: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const DependencyExtractorOutputSchema = z
  .object({
    edges: z.array(RawDependencyEdgeSchema).max(500)
  })
  .strict();

interface DependencyExtractorOutput {
  edges: Array<z.infer<typeof RawDependencyEdgeSchema>>;
}

interface DependencyLLMExtractorDeps {
  llmConfig: AppLLMConfig;
  llmClient: LLMClientPort<'ScannerAgent'>;
  promptVersion: string;
  policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  messageBus?: MessageBus<RuntimeEventMap>;
  eventStore?: EventStore;
  metrics?: Pick<MetricsStore, 'record'>;
}

interface DependencyLLMExtractionResult {
  edges: DependencyEdge[];
  reason: string;
}

export function createDependencyLLMExtractor(
  deps: DependencyLLMExtractorDeps
): (markets: DependencyMarketInput[], nowMs?: number) => Promise<DependencyLLMExtractionResult> {
  let circuitBackoffUntilMs = 0;

  return async (markets: DependencyMarketInput[], nowMs = Date.now()): Promise<DependencyLLMExtractionResult> => {
    if (markets.length < 2) return { edges: [], reason: 'insufficient_markets' };

    const scannerAgentConfig = deps.llmConfig.agents.ScannerAgent;
    // FW dependency extraction must run whenever scanner LLM is enabled (shadow or advisory),
    // otherwise hybrid dependency mode silently degenerates to deterministic-only.
    if (!deps.llmConfig.enabled || scannerAgentConfig.mode === 'disabled') {
      return { edges: [], reason: 'llm_disabled' };
    }

    if (nowMs < circuitBackoffUntilMs) {
      deps.metrics?.record({
        type: 'fw_dependency',
        timestamp: nowMs,
        data: {
          event: 'llm_extraction',
          marketCount: markets.length,
          edgeCount: 0,
          reason: 'llm_circuit_backoff'
        }
      });
      return { edges: [], reason: 'llm_circuit_backoff' };
    }

    const promptMarkets = markets.map((market) => ({
      market_id: market.marketId,
      question: market.question ?? null,
      category: market.category ?? null,
      tags: market.tags ?? []
    }));
    const promptEnvelope = {
      task: 'extract_market_dependencies',
      inputs: {
        markets: promptMarkets
      },
      output: {
        edges: [
          {
            marketA: 'market-a',
            marketB: 'market-b',
            relationType: 'mutual_exclusive',
            confidence: 0.75,
            evidence: 'shared_stem_and_opposite_markers'
          }
        ]
      }
    };

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model: scannerAgentConfig.model,
      temperature: 0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'developer',
          content:
            'Return JSON only with shape {"edges":[{"marketA":string,"marketB":string,"relationType":"mutual_exclusive"|"implies"|"complementary"|"partition","confidence":number,"evidence":string}]}. Use only the provided market list. Confidence must be between 0 and 1. Include only high-signal dependencies and avoid weak speculation. If uncertain, return {"edges":[]}. No prose.'
        },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ]
    };

    const call = await deps.llmClient.call('ScannerAgent', request, nowMs);
    const parsed = safeParseJSON(call.outputText);
    const normalized = normalizeExtractorOutput(parsed);
    const validated = normalized
      ? DependencyExtractorOutputSchema.safeParse(normalized)
      : ({ success: false } as const);

    const outputReason = deriveOutputReason(call, validated.success);
    if (outputReason.includes('circuit_open')) {
      circuitBackoffUntilMs = nowMs + Math.max(deps.llmConfig.circuitBreaker.cooldownMs, 1000);
    } else if (outputReason === 'ok') {
      circuitBackoffUntilMs = 0;
    }

    const edges = validated.success ? sanitizeEdges(validated.data.edges, markets, nowMs) : [];
    const confidence = averageConfidence(edges);

    deps.metrics?.record({
      type: 'fw_dependency',
      timestamp: nowMs,
      data: {
        event: 'llm_extraction',
        marketCount: markets.length,
        edgeCount: edges.length,
        reason: outputReason
      }
    });

    logLLMDecision({
      agent: 'ScannerAgent',
      mode: scannerAgentConfig.mode,
      task: 'extract_market_dependencies',
      subject: `fw-dependency:${markets.length}`,
      baseline: { market_count: markets.length },
      output: {
        edge_count: edges.length,
        reason: outputReason,
        edges: edges.slice(0, 20)
      },
      confidence,
      applied: true,
      clamp: {
        raw: parsed,
        final: { edge_count: edges.length, reason: outputReason, edges: edges.slice(0, 20) },
        bounds: { confidence: [0, 1] },
        violations: outputReason === 'ok' ? [] : [outputReason]
      },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: { market_count: markets.length, market_ids: markets.map((market) => market.marketId) },
      promptVersion: deps.promptVersion,
      policyHashes: deps.policyHashes,
      providerFallback: {
        providerId: scannerAgentConfig.provider,
        baseUrl: deps.llmConfig.providers[scannerAgentConfig.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      messageBus: deps.messageBus,
      store: deps.eventStore
    });

    return { edges, reason: outputReason };
  };
}

function normalizeExtractorOutput(parsed: unknown): DependencyExtractorOutput | null {
  if (Array.isArray(parsed)) {
    return { edges: parsed } as DependencyExtractorOutput;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  if (!Array.isArray(candidate.edges)) return null;
  return { edges: candidate.edges } as DependencyExtractorOutput;
}

function sanitizeEdges(
  rawEdges: DependencyExtractorOutput['edges'],
  markets: DependencyMarketInput[],
  nowMs: number
): DependencyEdge[] {
  const knownMarkets = new Set(markets.map((market) => market.marketId));
  const deduped = new Map<string, DependencyEdge>();

  for (const raw of rawEdges) {
    const marketA = raw.marketA.trim();
    const marketB = raw.marketB.trim();
    if (!knownMarkets.has(marketA) || !knownMarkets.has(marketB) || marketA === marketB) {
      continue;
    }

    const edge = withSortedMarkets({
      marketA,
      marketB,
      relationType: raw.relationType,
      confidence: clampDependencyConfidence(raw.confidence),
      source: 'llm',
      evidence: raw.evidence ?? 'llm_dependency_extraction',
      extractedAtMs: nowMs
    });

    const key = dependencyEdgeKey(edge);
    const existing = deduped.get(key);
    if (!existing || edge.confidence > existing.confidence) {
      deduped.set(key, edge);
    }
  }

  return Array.from(deduped.values());
}

function averageConfidence(edges: DependencyEdge[]): number {
  if (edges.length === 0) return 0;
  const total = edges.reduce((sum, edge) => sum + clampDependencyConfidence(edge.confidence), 0);
  return clampDependencyConfidence(total / edges.length);
}

function deriveOutputReason(call: LLMCallResult, isValidOutput: boolean): string {
  if (isValidOutput) return 'ok';
  if (call.outputText !== null) return 'invalid_output';

  if (call.status === 'timeout') return 'llm_timeout';
  if (call.status === 'disabled') return 'llm_disabled';
  if (call.status === 'fallback') {
    return `llm_fallback_${sanitizeReasonFragment(call.fallbackReason ?? 'unknown')}`;
  }
  if (call.status === 'error') {
    return `llm_error_${sanitizeReasonFragment(call.error?.type ?? 'unknown')}`;
  }

  return 'missing_output_text';
}

function sanitizeReasonFragment(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  const compact = normalized.replace(/^_+|_+$/g, '');
  return compact.length > 0 ? compact : 'unknown';
}
