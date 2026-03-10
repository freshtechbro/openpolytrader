import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { PortfolioAnomalySchema } from '../../domain/llm.js';
import type { PortfolioSnapshot, VenueReconciliationIssue } from '../../domain/portfolio.js';
import {
  callAgentJson,
  logAgentDecision,
  withAgent,
  type AgentLlmConfig
} from '../../services/llm/AgentLlm.js';
import type { LLMRequest } from '../../services/llm/types.js';

type PortfolioAnomalyLlmConfig = AgentLlmConfig<'PortfolioAgent'>;

export async function analyzePortfolioAnomaly(input: {
  snapshot: PortfolioSnapshot;
  positionsCount: number;
  pendingExpectedFills: number;
  venueIssues?: VenueReconciliationIssue[];
  nowMs: number;
  llm: PortfolioAnomalyLlmConfig;
  messageBus: MessageBus<RuntimeEventMap>;
  store?: EventStore;
  onIncident?: (alert: {
    type: 'llm_portfolio_anomaly';
    severity: 'low' | 'medium' | 'high';
    reason: string | null;
    confidence: number;
    timestamp: number;
  }) => void;
}): Promise<void> {
  const { snapshot, positionsCount, pendingExpectedFills, venueIssues, nowMs, llm, messageBus, store, onIncident } =
    input;
  const venueIssuesCount = Array.isArray(venueIssues) ? venueIssues.length : 0;

  const promptEnvelope = {
    task: 'detect_anomaly',
    inputs: {
      snapshot: {
        total_capital: snapshot.totalCapital,
        available_capital: snapshot.availableCapital,
        daily_pnl: snapshot.dailyPnL,
        open_inventory_age_ms: snapshot.openInventoryAgeMs ?? 0,
        market_exposure: snapshot.marketExposure,
        positions_count: positionsCount,
        pending_expected_fills: pendingExpectedFills,
        venue_issues_count: venueIssuesCount
      }
    },
    output: { anomaly: false, severity: 'low|medium|high', reason: null, confidence: 0.0 }
  };

  const request: LLMRequest = {
    endpoint: 'chat.completions',
    model: llm.config.agents.PortfolioAgent.model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'developer',
        content:
          'Return JSON only, with shape: {"anomaly":boolean,"severity":"low"|"medium"|"high","reason":string|null,"confidence":number}. Use only the inputs. Only flag anomaly=true when evidence is strong; otherwise set anomaly=false and reason=null. Confidence must be between 0 and 1. No prose.'
      },
      { role: 'user', content: JSON.stringify(promptEnvelope) }
    ]
  };

  const context = withAgent('PortfolioAgent', llm);
  const { call, parsed, validated, missingOutput, violations } = await callAgentJson(
    context,
    request,
    PortfolioAnomalySchema
  );
  const finalDecision = validated.success
    ? validated.data
    : {
        anomaly: false,
        severity: 'low',
        reason: missingOutput ? 'missing_output_text' : 'invalid_output',
        confidence: 0
      };

  if (validated.success && validated.data.anomaly) {
    const alert = {
      type: 'llm_portfolio_anomaly' as const,
      severity: validated.data.severity ?? 'low',
      reason: validated.data.reason,
      confidence: validated.data.confidence,
      timestamp: nowMs
    };
    messageBus.emit('ops:alert', alert);
    onIncident?.(alert);
  }

  logAgentDecision(context, {
    mode: llm.config.agents.PortfolioAgent.mode,
    task: 'detect_anomaly',
    subject: 'system:portfolio',
    baseline: promptEnvelope.inputs,
    output: finalDecision,
    confidence: finalDecision.confidence,
    applied: validated.success ? validated.data.anomaly : false,
    clamp: { raw: parsed, final: finalDecision, violations },
    nowMs,
    call,
    request,
    promptEnvelopeForHash: promptEnvelope,
    contextForHash: promptEnvelope.inputs,
    messageBus,
    store
  });
}
