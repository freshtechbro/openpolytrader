import type { PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import { ExecutionBasketRunner } from './ExecutionBasketRunner.js';
import type {
  ExecutionAttemptResult,
  ExecutionContext,
  ExecutionEvAttemptResult,
  ExecutionEvParams,
  ExecutionFillServices,
  ExecutionIdempotencyServices,
  ExecutionRuntimeServices,
  ExecutionTimeouts,
  ExecutionUnwindServices,
  PairedExecutionService
} from './ExecutionContracts.js';
import { ExecutionEvRunner } from './ExecutionEvRunner.js';
import { applyMultiplier, coerceNonceValue, extractOrderId, isTimeoutError, withTimeout } from './ExecutionShared.js';

interface ExecutionModeSupportDeps {
  runtime: ExecutionRuntimeServices;
  idempotency: ExecutionIdempotencyServices;
  fills: ExecutionFillServices;
  unwind: ExecutionUnwindServices;
  pairedExecution: PairedExecutionService;
  clob: PolymarketClob;
  incidentTracker?: IncidentTracker;
  metrics?: MetricsStore;
  portfolio?: PortfolioAgent;
  userRealtime?: PolymarketRealtime;
}

export class ExecutionModeSupport {
  constructor(private readonly deps: ExecutionModeSupportDeps) {}

  getEffectiveTimeouts(marketId: string, opportunityId: string, nowMs: number): ExecutionTimeouts {
    const base = this.deps.runtime.getTimeouts();
    const mode = this.deps.runtime.getExecutionAdvisorMode();
    const advisor = this.deps.runtime.getExecutionAdvisor();
    if (!advisor || mode === 'disabled') return base;

    const hint = advisor.getHint(marketId, nowMs);
    if (!hint) return base;

    const multiplier = Math.min(1, Math.max(0.1, hint.timeoutMultiplier));
    const advised: ExecutionTimeouts = {
      submitTimeoutMs: applyMultiplier(base.submitTimeoutMs, multiplier),
      ackTimeoutMs: applyMultiplier(base.ackTimeoutMs, multiplier),
      fillTimeoutMs: applyMultiplier(base.fillTimeoutMs, multiplier),
      cancelTimeoutMs: applyMultiplier(base.cancelTimeoutMs, multiplier)
    };

    this.deps.metrics?.record({
      type: 'shadow_decision',
      timestamp: nowMs,
      data: {
        agent: 'ExecutionAgent',
        marketId,
        opportunityId,
        mode,
        hint: { timeoutMultiplier: hint.timeoutMultiplier, unwindHint: hint.unwindHint, confidence: hint.confidence },
        baseTimeouts: base,
        advisedTimeouts: advised
      }
    });

    return mode === 'advisory' ? advised : base;
  }

  async executeBasketArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionAttemptResult> {
    const timeouts = this.deps.runtime.getTimeouts();
    return new ExecutionBasketRunner({
      defaultExecutionMode: this.deps.runtime.getPolicy().fwBasketExecutionMode,
      tradingEnabled: this.deps.runtime.getTradingEnabled(),
      tradingMode: this.deps.runtime.getTradingMode(),
      clob: this.deps.clob,
      incidentTracker: this.deps.incidentTracker,
      metrics: this.deps.metrics,
      userRealtime: this.deps.userRealtime,
      timeouts: {
        submitTimeoutMs: timeouts.submitTimeoutMs,
        fillTimeoutMs: timeouts.fillTimeoutMs,
        cancelTimeoutMs: timeouts.cancelTimeoutMs
      },
      idempotency: this.deps.idempotency,
      fills: this.deps.fills,
      unwind: this.deps.unwind,
      paired: this.deps.pairedExecution,
      withTimeout,
      coerceNonceValue,
      extractOrderId
    }).executeBasketArbitrage(opportunity, size, context);
  }

  async executeEvOrder(
    opportunity: ArbitrageOpportunity,
    size: number,
    params: ExecutionEvParams
  ): Promise<ExecutionEvAttemptResult> {
    return new ExecutionEvRunner({
      clob: this.deps.clob,
      portfolio: this.deps.portfolio,
      incidentTracker: this.deps.incidentTracker,
      metrics: this.deps.metrics,
      idempotency: this.deps.idempotency,
      fills: this.deps.fills,
      withTimeout,
      isTimeoutError,
      coerceNonceValue,
      extractOrderId
    }).execute(opportunity, size, params);
  }
}
