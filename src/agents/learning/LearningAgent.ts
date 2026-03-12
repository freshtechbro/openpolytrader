import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { StoredEvent } from '../../core/EventStore.js';
import type { EventStore } from '../../core/EventStore.js';
import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { LearningInsightEventSchema, LearningInsightSchema } from '../../domain/llm.js';
import {
  callAgentJson,
  logAgentDecision,
  withAgent,
  type AgentLlmConfig
} from '../../services/llm/AgentLlm.js';
import type { LLMRequest } from '../../services/llm/types.js';
import { LearningStatsTracker } from './LearningStatsTracker.js';

type MessageBusEvent = keyof RuntimeEventMap & string;
type MessageBusHandler = (payload: RuntimeEventMap[MessageBusEvent]) => void;

interface LearningAgentConfig {
  enabled: boolean;
  messageBus?: MessageBus<RuntimeEventMap>;
  statsRetentionMs?: number;
  statsMaxMarkets?: number;
  promptTopNMarkets?: number;
  llm?: AgentLlmConfig<'LearningAgent'> & {
    windowMs: number;
    minEventsPerRun: number;
    intervalMs?: number;
  };
}

/**
 * Phase 1: learning remains advisory-only.
 * - No online policy updates or autonomous execution changes.
 * - Records key decisions/events to the EventStore for offline analysis.
 * - Emits bounded `learning:insight` summaries for downstream consumers.
 */
export class LearningAgent {
  private started = false;
  private messageBus: MessageBus<RuntimeEventMap>;
  private timer: NodeJS.Timeout | null = null;
  private readonly statsRetentionMs: number;
  private readonly statsMaxMarkets: number;
  private readonly promptTopNMarkets: number;
  private subscriptions: Array<{ event: MessageBusEvent; handler: MessageBusHandler }> = [];
  private readonly statsTracker: LearningStatsTracker;

  private insightCache = new Map<
    string,
    { insight: (typeof LearningInsightSchema)['_output']; expiresAtMs: number }
  >();

  constructor(
    private config: LearningAgentConfig,
    private store: EventStore
  ) {
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config.messageBus, 'LearningAgent');
    this.statsRetentionMs = Math.max(config.statsRetentionMs ?? 24 * 60 * 60 * 1000, 0);
    this.statsMaxMarkets = Math.max(config.statsMaxMarkets ?? 5000, 1);
    this.promptTopNMarkets = Math.max(config.promptTopNMarkets ?? 100, 1);
    this.statsTracker = new LearningStatsTracker(
      this.statsRetentionMs,
      this.statsMaxMarkets,
      this.promptTopNMarkets
    );
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.statsTracker.restore(this.store);

    const record = (type: string, payload: unknown, metadata?: StoredEvent['metadata']) => {
      this.store.append({
        id: randomUUID(),
        timestamp: Date.now(),
        type,
        payload,
        metadata: metadata ?? {}
      });
    };

    const subscribe = <K extends MessageBusEvent>(
      event: K,
      handler: (payload: RuntimeEventMap[K]) => void
    ) => {
      this.messageBus.on(event, handler);
      this.subscriptions.push({ event, handler: handler as MessageBusHandler });
    };

    subscribe('opportunity:detected', (event) => {
      record('opportunity:detected', event, { agent: 'ScannerAgent' });
      const marketId = event.opportunity?.marketId;
      const edge = event.opportunity?.edge;
      if (typeof marketId === 'string' && marketId.length > 0) {
        this.updateMarketStats(marketId, { opportunities: 1, edge });
      }
    });
    subscribe('risk:approved', (event) => {
      record('risk:approved', event, { agent: 'RiskAgent' });
      const marketId = event.opportunity?.marketId;
      if (typeof marketId === 'string' && marketId.length > 0) {
        this.updateMarketStats(marketId, { approvals: 1 });
      }
    });
    subscribe('ops:health', (event) => record('ops:health', event, { agent: 'OpsAgent' }));
    subscribe('ops:alert', (event) => record('ops:alert', event, { agent: 'OpsAgent' }));

    // Forward-compatible subscriptions (emitted once LLM integration is rolled out).
    subscribe('execution:outcome', (event) => {
      record('execution:outcome', event, { agent: 'ExecutionAgent' });
      if (event.marketId && event.status === 'timeout') {
        this.updateMarketStats(event.marketId, { timeouts: 1 });
      }
    });
    subscribe('execution:fill', (event) => {
      record('execution:fill', event, { agent: 'ExecutionAgent' });
      if (event.marketId && typeof event.slippage === 'number') {
        this.updateMarketStats(event.marketId, { slippageSample: event.slippage });
      }
    });

    const intervalMs = Math.max(this.config.llm?.intervalMs ?? 30000, 0);
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), intervalMs);
    }
  }

  stop(): void {
    this.maybePersistStatsSnapshot(Date.now(), { force: true });
    for (const { event, handler } of this.subscriptions.splice(0, this.subscriptions.length)) {
      this.messageBus.off(event, handler);
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getInsight(marketId: string, nowMs = Date.now()): (typeof LearningInsightSchema)['_output'] | null {
    const cached = this.insightCache.get(marketId);
    if (!cached) return null;
    if (nowMs >= cached.expiresAtMs) {
      this.insightCache.delete(marketId);
      return null;
    }
    return cached.insight;
  }

  async synthesizeNow(): Promise<void> {
    await this.synthesizeInsights();
  }

  private updateMarketStats(
    marketId: string,
    delta: {
      opportunities?: number;
      approvals?: number;
      edge?: number;
      slippageSample?: number;
      timeouts?: number;
    },
    nowMs = Date.now()
  ): void {
    this.statsTracker.update(marketId, delta, nowMs, { recordPending: true, markDirty: true });
    this.messageBus.emit('learning:update', { at_ms: nowMs, markets_tracked: this.statsTracker.size });
  }

  private async tick(): Promise<void> {
    const nowMs = Date.now();
    this.statsTracker.prune(nowMs);
    this.statsTracker.maybePersist(this.store, nowMs);
    await this.maybeSynthesize();
  }

  private async maybeSynthesize(): Promise<void> {
    const llm = this.config.llm;
    if (!llm) return;
    if (!llm.config.enabled) return;
    if (llm.config.agents.LearningAgent.mode !== 'active') return;

    if (!this.statsTracker.shouldSynthesize(llm.minEventsPerRun)) return;

    await this.synthesizeInsights();
  }

  private async synthesizeInsights(): Promise<void> {
    const llm = this.config.llm;
    if (!llm) return;
    if (!llm.config.enabled) return;
    if (llm.config.agents.LearningAgent.mode !== 'active') return;

    const nowMs = Date.now();
    this.statsTracker.prune(nowMs);
    const stats_by_market: Record<
      string,
      { opportunities: number; approvals: number; avg_edge: number; avg_slippage: number; timeouts: number }
    > = {};

    const selectedForPrompt = this.statsTracker.selectMarketsForPrompt(nowMs, llm.windowMs);
    for (const [marketId, stats] of selectedForPrompt) {
      stats_by_market[marketId] = {
        opportunities: stats.opportunities,
        approvals: stats.approvals,
        avg_edge: stats.avgEdge,
        avg_slippage: stats.avgSlippage,
        timeouts: stats.timeouts
      };
    }

    const promptEnvelope = {
      task: 'summarize_outcomes',
      inputs: {
        window_ms: llm.windowMs,
        stats_by_market
      },
      output: {
        insights: [
          {
            market_id: 'market_id',
            signal: 'high_confidence|medium_confidence|low_confidence|neutral',
            value: 0.0,
            ttl_ms: 60000,
            confidence: 0.0
          }
        ]
      }
    };

    const model = llm.config.agents.LearningAgent.model;
    const instruction =
      'Return JSON only, with shape: {"insights":[{"market_id":string,"signal":"high_confidence"|"medium_confidence"|"low_confidence"|"neutral","value":number,"ttl_ms":number,"confidence":number}]}. Use only the inputs. Include only markets with clear evidence; otherwise return an empty insights array. ttl_ms must be between 30000 and window_ms. Confidence must be between 0 and 1. No prose.';

    const request: LLMRequest =
      model.startsWith('claude-')
        ? {
            endpoint: 'messages',
            model,
            system: instruction,
            messages: [{ role: 'user', content: JSON.stringify(promptEnvelope) }],
            temperature: 0,
            max_tokens: 800
          }
        : {
            endpoint: 'chat.completions',
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'developer', content: instruction },
              { role: 'user', content: JSON.stringify(promptEnvelope) }
            ],
            max_tokens: 800
          };

    const context = withAgent('LearningAgent', llm);
    const { call, validated, missingOutput } = await callAgentJson(
      context,
      request,
      z.object({ insights: z.array(LearningInsightSchema) }).strict()
    );

    const insightPayload = validated.success
      ? {
          insights: validated.data.insights.map((insight) => ({
            ...insight,
            source: 'learning' as const,
            kind: 'outcome_summary' as const
          })),
          generatedAtMs: nowMs
        }
      : null;

    if (insightPayload) {
      LearningInsightEventSchema.parse(insightPayload);
      for (const insight of insightPayload.insights) {
        this.insightCache.set(insight.market_id, {
          insight,
          expiresAtMs: nowMs + insight.ttl_ms
        });
      }
      this.messageBus.emit('learning:insight', insightPayload);
    }
    this.statsTracker.resetPendingEvents();

    const failureOutput = missingOutput
      ? { error: 'missing_output_text', status: call.status, llm_error: call.error ?? null }
      : { error: 'invalid_output' };

    logAgentDecision(context, {
      mode: llm.config.agents.LearningAgent.mode,
      task: 'summarize_outcomes',
      subject: 'system:learning',
      baseline: promptEnvelope.inputs,
      output: insightPayload ?? failureOutput,
      confidence: insightPayload ? average(insightPayload.insights.map((i) => i.confidence)) : 0,
      applied: Boolean(insightPayload),
      clamp: { violations: missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output'] },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: promptEnvelope.inputs,
      messageBus: this.messageBus,
      store: this.store
    });
    if (!validated.success && call.error) {
      this.messageBus.emit(
        'llm:error',
        {
          agent: 'LearningAgent',
          provider_id: call.providerId ?? llm.config.agents.LearningAgent.provider,
          endpoint: call.endpoint ?? request.endpoint,
          model: call.model ?? request.model,
          error: call.error,
          at_ms: nowMs
        }
      );
    }
  }

  private maybePersistStatsSnapshot(nowMs: number, options: { force?: boolean } = {}): void {
    this.statsTracker.maybePersist(this.store, nowMs, options);
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
