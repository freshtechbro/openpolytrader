import type { TradePolicy } from '../../config/policy.js';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../../config/risk.js';
import type { TradingMode } from '../../config/env.js';
import type { EventStore, StoredEvent } from '../../core/EventStore.js';
import type { CircuitBreakerRegistry } from '../../core/CircuitBreaker.js';
import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import {
  type ExecutionEvent,
  getRequiredAction,
  type PairedExecutionState,
  type ExecutionState
} from '../../domain/execution.js';
import { createIdempotencyKey, type IdempotencyRecord } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import { PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { PolymarketRealtime, UserOrderUpdate, UserTradeUpdate } from '../../services/PolymarketRealtime.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type { ExecutionAdvisor } from './ExecutionAdvisor.js';
import {
  cancelOutstandingBatchOrders,
  ExecutionIdempotencyStore,
  ExecutionLifecycle,
  ExecutionUnwindSupport,
  waitForBatchFillOutcomes
} from './ExecutionAgentSupport.js';
import type {
  ExecutionAttemptResult,
  ExecutionContext,
  ExecutionEvParams,
  ExecutionFillServices,
  ExecutionPairedAttemptResult,
  ExecutionIdempotencyServices,
  ExecutionPreflightEffect,
  ExecutionRuntimeServices,
  ExecutionTimeouts,
  ExecutionUnwindServices,
  PairedExecutionService
} from './ExecutionContracts.js';
import { ExecutionFailureRecovery } from './ExecutionFailureRecovery.js';
import { ExecutionModeSupport } from './ExecutionModeSupport.js';
import { ExecutionOrderTracker } from './ExecutionOrderTracker.js';
import { ExecutionPairedRunner } from './ExecutionPairedRunner.js';
import { runExecutionPreflight } from './ExecutionPreflight.js';
import {
  coerceNonceValue,
  extractOrderId,
  formatCancelError,
  isCancelFailure,
  isOrderSuccessful,
  isTimeoutError,
  withTimeout
} from './ExecutionShared.js';

interface ExecutionAgentConfig {
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  messageBus?: MessageBus<RuntimeEventMap>;
  eventStore?: EventStore;
  riskConfig?: RiskConfig;
  portfolio?: PortfolioAgent;
  userRealtime?: PolymarketRealtime;
  circuitBreakers?: CircuitBreakerRegistry;
  executionAdvisor?: ExecutionAdvisor;
  executionAdvisorMode?: 'disabled' | 'shadow' | 'advisory';
  submitTimeoutMs?: number;
  ackTimeoutMs?: number;
  fillTimeoutMs?: number;
  cancelTimeoutMs?: number;
}

export class ExecutionAgent {
  private tradingEnabled: boolean;
  private tradingMode: TradingMode;
  private messageBus: MessageBus<RuntimeEventMap>;
  private store?: EventStore;
  private riskConfig: RiskConfig;
  private portfolio?: PortfolioAgent;
  private userRealtime?: PolymarketRealtime;
  private circuitBreakers?: CircuitBreakerRegistry;
  private timeouts: ExecutionTimeouts;
  private executionAdvisor?: ExecutionAdvisor;
  private executionAdvisorMode: 'disabled' | 'shadow' | 'advisory' = 'disabled';
  private orderTracker: ExecutionOrderTracker;
  private idempotency: ExecutionIdempotencyStore;
  private lifecycle: ExecutionLifecycle;
  private modeSupport: ExecutionModeSupport;
  private unwindSupport: ExecutionUnwindSupport;
  private activeExecutions = new Map<string, PairedExecutionState>();

  constructor(
    private policy: TradePolicy,
    private clob: PolymarketClob,
    private incidentTracker?: IncidentTracker,
    private metrics?: MetricsStore,
    config?: ExecutionAgentConfig
  ) {
    this.tradingEnabled = config?.tradingEnabled ?? false;
    this.tradingMode = config?.tradingMode ?? 'off';
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config?.messageBus, 'ExecutionAgent');
    this.store = config?.eventStore;
    this.riskConfig = config?.riskConfig ?? DEFAULT_RISK_CONFIG;
    this.portfolio = config?.portfolio;
    this.userRealtime = config?.userRealtime;
    this.circuitBreakers = config?.circuitBreakers;
    this.executionAdvisor = config?.executionAdvisor;
    this.executionAdvisorMode = config?.executionAdvisorMode ?? 'disabled';
    this.orderTracker = new ExecutionOrderTracker({
      messageBus: this.messageBus,
      portfolio: this.portfolio,
      entrySlippageToleranceBps: this.policy.entrySlippageToleranceBps
    });
    this.idempotency = new ExecutionIdempotencyStore({ clob: this.clob, store: this.store });
    this.lifecycle = new ExecutionLifecycle({
      messageBus: this.messageBus,
      store: this.store,
      metrics: this.metrics,
      activeExecutions: this.activeExecutions
    });
    this.unwindSupport = new ExecutionUnwindSupport({
      getPolicy: () => this.policy,
      getRiskConfig: () => this.riskConfig,
      getExecutionAdvisor: () => this.executionAdvisor,
      getExecutionAdvisorMode: () => this.executionAdvisorMode,
      clob: this.clob,
      incidentTracker: this.incidentTracker,
      metrics: this.metrics,
      portfolio: this.portfolio
    });
    this.timeouts = {
      submitTimeoutMs: config?.submitTimeoutMs ?? policy.submitTimeoutMs,
      ackTimeoutMs: config?.ackTimeoutMs ?? policy.ackTimeoutMs,
      fillTimeoutMs: config?.fillTimeoutMs ?? policy.fillTimeoutMs,
      cancelTimeoutMs: config?.cancelTimeoutMs ?? policy.cancelTimeoutMs
    };

    const runtimeServices: ExecutionRuntimeServices = {
      getPolicy: () => this.policy,
      getTimeouts: () => this.timeouts,
      getExecutionAdvisor: () => this.executionAdvisor,
      getExecutionAdvisorMode: () => this.executionAdvisorMode
    };
    const idempotencyServices: ExecutionIdempotencyServices = {
      ensureRecord: (key, nowMs) => this.idempotency.ensureRecord(key, nowMs),
      getRecord: (key) => this.idempotency.getRecord(key),
      saveRecord: (record) => this.idempotency.saveRecord(record),
      markFailed: (key, nowMs) => this.idempotency.markFailed(key, nowMs)
    };
    const fillServices: ExecutionFillServices = {
      waitForFillOutcome: (orderId, desiredSize, timeoutMs) =>
        this.orderTracker.waitForFillOutcome(orderId, desiredSize, timeoutMs),
      waitForBatchFillOutcomes: (acceptedOrders, size, timeoutMs) =>
        this.waitForBatchFillOutcomes(acceptedOrders, size, timeoutMs),
      cancelOutstandingBatchOrders: (outcomes, opportunityId, nowMs) =>
        cancelOutstandingBatchOrders(outcomes, opportunityId, nowMs, {
          clob: this.clob,
          incidentTracker: this.incidentTracker,
          cancelTimeoutMs: this.timeouts.cancelTimeoutMs,
          markIdempotencyFailed: (key, atMs) => this.idempotency.markFailed(key, atMs)
        })
    };
    const unwindServices: ExecutionUnwindServices = {
      unwindBasketLegs: (basketOpportunity, legs, size, nowMs) =>
        this.unwindBasketLegs(basketOpportunity, legs, size, nowMs),
      calculateUnwindPrice: (entryPrice, tickSize, advisory) =>
        this.unwindSupport.calculateUnwindPrice(entryPrice, tickSize, advisory)
    };
    const pairedService: PairedExecutionService = {
      execute: (opportunity, size, context) =>
        this.executePairedArbitrage(opportunity, size, context)
    };

    this.modeSupport = new ExecutionModeSupport({
      runtime: runtimeServices,
      idempotency: idempotencyServices,
      fills: fillServices,
      unwind: unwindServices,
      pairedExecution: pairedService,
      clob: this.clob,
      incidentTracker: this.incidentTracker,
      metrics: this.metrics,
      portfolio: this.portfolio,
      userRealtime: this.userRealtime
    });

    if (this.userRealtime) {
      this.userRealtime.on('user:order', (event) => this.orderTracker.handleUserOrderUpdate(event as UserOrderUpdate));
      this.userRealtime.on('user:trade', (event) => this.orderTracker.handleUserTradeUpdate(event as UserTradeUpdate));
    }
  }

  isTradingEnabled(): boolean {
    return this.tradingEnabled && this.tradingMode === 'live';
  }

  updateTradingMode(mode: TradingMode): void {
    this.tradingMode = mode;
  }

  updateTradingEnabled(enabled: boolean): void {
    this.tradingEnabled = enabled;
  }

  updatePolicy(policy: TradePolicy): void {
    this.policy = policy;
    this.orderTracker.updatePolicy(policy);
    this.timeouts = {
      submitTimeoutMs: policy.submitTimeoutMs,
      ackTimeoutMs: policy.ackTimeoutMs,
      fillTimeoutMs: policy.fillTimeoutMs,
      cancelTimeoutMs: policy.cancelTimeoutMs
    };
  }

  updateRiskConfig(riskConfig: RiskConfig): void {
    this.riskConfig = riskConfig;
  }

  getActiveExecutions(): PairedExecutionState[] {
    return Array.from(this.activeExecutions.values());
  }

  restoreActiveExecutions(events: StoredEvent[]): void {
    this.activeExecutions.clear();
    const ordered = events
      .filter((event) => event.type === 'execution:transition')
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const event of ordered) {
      const payload = event.payload as { snapshot?: PairedExecutionState };
      const snapshot = payload?.snapshot;
      if (!snapshot) continue;
      const action = getRequiredAction(snapshot.state);
      if (action === 'none') {
        this.activeExecutions.delete(snapshot.id);
      } else {
        this.activeExecutions.set(snapshot.id, snapshot);
      }
    }
  }

  async executeBasketArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionAttemptResult> {
    return this.modeSupport.executeBasketArbitrage(opportunity, size, context);
  }

  async executeEvOpportunity(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionAttemptResult> {
    const nowMs = context?.nowMs ?? Date.now();
    const side = opportunity.side;
    const idempotencyKey = createIdempotencyKey(
      `${opportunity.marketId}:${side === 'no' ? opportunity.noTokenId : opportunity.yesTokenId}:${opportunity.detectedAt}:ev`
    );
    const executionId = idempotencyKey;
    const idleState: ExecutionState = 'idle';
    const trackedOrderIds: string[] = [];
    const finalize = (result: ExecutionAttemptResult, atMs = Date.now()) => {
      this.lifecycle.emitExecutionOutcome(opportunity, result, atMs);
      if (trackedOrderIds.length > 0) this.orderTracker.cleanupOrderTracking(trackedOrderIds);
      return result;
    };

    if (!side) {
      return finalize(
        { kind: 'ev', status: 'blocked', reason: 'ev_missing_side', idempotencyKey, executionId, state: idleState },
        nowMs
      );
    }

    if (this.circuitBreakers?.isOpen(opportunity.marketId)) {
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'circuit_breaker',
        timestamp: nowMs,
        opportunityId: opportunity.id,
        detail: { message: 'market circuit breaker open' }
      });
      return finalize(
        { kind: 'ev', status: 'blocked', reason: 'circuit_breaker', idempotencyKey, executionId, state: idleState, side },
        nowMs
      );
    }

    const timeouts = this.modeSupport.getEffectiveTimeouts(opportunity.marketId, opportunity.id, nowMs);
    this.idempotency.prune(nowMs - this.policy.orderToTradeWindowMs);
    const record = this.idempotency.ensureRecord(idempotencyKey, nowMs);
    const preflight = runExecutionPreflight({
      nowMs,
      opportunity,
      policy: this.policy,
      tradingEnabled: this.tradingEnabled,
      tradingMode: this.tradingMode,
      userRealtime: this.userRealtime,
      metrics: this.metrics,
      idempotencyKey,
      executionId,
      idleState,
      isEv: true,
      yesBook: context?.yesBook,
      noBook: context?.noBook
    });
    if (preflight.blocked) {
      this.applyPreflightEffects(preflight.effects);
      return finalize(preflight.blocked, nowMs);
    }

    const evParams: ExecutionEvParams = {
      nowMs,
      idempotencyKey,
      executionId,
      idleState,
      timeouts: {
        submitTimeoutMs: timeouts.submitTimeoutMs,
        fillTimeoutMs: timeouts.fillTimeoutMs
      },
      record,
      trackedOrderIds
    };
    return finalize(await this.modeSupport.executeEvOrder(opportunity, size, evParams), Date.now());
  }

  private async waitForBatchFillOutcomes(
    acceptedOrders: Parameters<typeof waitForBatchFillOutcomes>[0],
    size: number,
    timeoutMs: number
  ) {
    return waitForBatchFillOutcomes(
      acceptedOrders,
      size,
      timeoutMs,
      (orderId, desiredSize, fillTimeoutMs) => this.orderTracker.waitForFillOutcome(orderId, desiredSize, fillTimeoutMs)
    );
  }

  private async unwindBasketLegs(
    basketOpportunity: ArbitrageOpportunity,
    legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
    size: number,
    nowMs: number
  ): Promise<void> {
    await this.unwindSupport.unwindBasketLegs(
      basketOpportunity,
      legs,
      size,
      nowMs,
      this.timeouts.submitTimeoutMs
    );
  }

  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionAttemptResult> {
    if (opportunity.type === 'ev') return this.executeEvOpportunity(opportunity, size, context);
    return this.executePairedArbitrage(opportunity, size, context);
  }

  private async executePairedArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionPairedAttemptResult> {
    const nowMs = context?.nowMs ?? Date.now();

    const idempotencyKey = createIdempotencyKey(
      `${opportunity.marketId}:${opportunity.yesTokenId}:${opportunity.noTokenId}:${opportunity.detectedAt}`
    );
    const executionId = idempotencyKey;
    const idleState: ExecutionState = 'idle';
    const trackedOrderIds: string[] = [];
    const finalize = (result: ExecutionPairedAttemptResult, atMs = Date.now()) => {
      this.lifecycle.emitExecutionOutcome(opportunity, result, atMs);
      if (trackedOrderIds.length > 0) this.orderTracker.cleanupOrderTracking(trackedOrderIds);
      return result;
    };

    if (this.circuitBreakers?.isOpen(opportunity.marketId)) {
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'circuit_breaker',
        timestamp: nowMs,
        opportunityId: opportunity.id,
        detail: { message: 'market circuit breaker open' }
      });
      return finalize(
        { kind: 'paired', status: 'blocked', reason: 'circuit_breaker', idempotencyKey, executionId, state: idleState },
        nowMs
      );
    }

    const timeouts = this.modeSupport.getEffectiveTimeouts(opportunity.marketId, opportunity.id, nowMs);
    const yesIdempotencyKey = `${idempotencyKey}:yes`;
    const noIdempotencyKey = `${idempotencyKey}:no`;
    this.idempotency.prune(nowMs - this.policy.orderToTradeWindowMs);
    const yesRecord: IdempotencyRecord = this.idempotency.ensureRecord(yesIdempotencyKey, nowMs);
    const noRecord: IdempotencyRecord = this.idempotency.ensureRecord(noIdempotencyKey, nowMs);

    const preflight = runExecutionPreflight({
      nowMs,
      opportunity,
      policy: this.policy,
      tradingEnabled: this.tradingEnabled,
      tradingMode: this.tradingMode,
      userRealtime: this.userRealtime,
      metrics: this.metrics,
      idempotencyKey,
      executionId,
      idleState,
      isEv: false,
      yesBook: context?.yesBook,
      noBook: context?.noBook
    });
    if (preflight.blocked) {
      this.applyPreflightEffects(preflight.effects);
      return finalize(preflight.blocked as ExecutionPairedAttemptResult, nowMs);
    }

    const failureRecovery = new ExecutionFailureRecovery({
      clob: this.clob,
      incidentTracker: this.incidentTracker,
      opportunity,
      context,
      timeouts: {
        submitTimeoutMs: timeouts.submitTimeoutMs,
        cancelTimeoutMs: timeouts.cancelTimeoutMs
      },
      idempotencyKey,
      executionId,
      yesIdempotencyKey,
      noIdempotencyKey,
      markIdempotencyFailed: (key, atMs) => this.idempotency.markFailed(key, atMs),
      resolveUnwindTickSize: (leg, currentOpportunity, executionContext) =>
        this.unwindSupport.resolveUnwindTickSize(leg, currentOpportunity, executionContext),
      calculateUnwindPrice: (entryPrice, tickSize, advisory) =>
        this.unwindSupport.calculateUnwindPrice(entryPrice, tickSize, advisory),
      recordUnwindPortfolio: (marketId, tokenId, entryPrice, unwindPrice, unwindSize) =>
        this.unwindSupport.recordUnwindPortfolio(marketId, tokenId, entryPrice, unwindPrice, unwindSize),
      transition: (current, event) => this.lifecycle.transition(current, event as ExecutionEvent),
      withTimeout,
      extractOrderId,
      isOrderSuccessful,
      isCancelFailure,
      formatCancelError
    });

    const pairedRunner = new ExecutionPairedRunner({
      clob: this.clob,
      metrics: this.metrics,
      portfolio: this.portfolio,
      policy: { maxLegSkewMs: this.policy.maxLegSkewMs },
      transition: (current, event) => this.lifecycle.transition(current, event as ExecutionEvent),
      waitForFillOutcome: (orderId, desiredSize, timeoutMs) =>
        this.orderTracker.waitForFillOutcome(orderId, desiredSize, timeoutMs),
      saveIdempotencyRecord: (record) => this.idempotency.saveRecord(record),
      withTimeout,
      isTimeoutError,
      coerceNonceValue,
      extractOrderId,
      handleFailure: (current, atMs, failedSize, resultReason, incidentReason, detail, yesOrder, noOrder) =>
        failureRecovery.handleFailure(current, atMs, failedSize, resultReason, incidentReason, detail, yesOrder, noOrder),
      handleObservedPartialFill: (current, atMs, filledLeg, filledSize, failureReason, failureDetail, yesOrder, noOrder) =>
        failureRecovery.handleObservedPartialFill(
          current,
          atMs,
          filledLeg,
          filledSize,
          failureReason,
          failureDetail,
          yesOrder,
          noOrder
        )
    });

    return finalize(
      await pairedRunner.execute({
        opportunity,
        size,
        nowMs,
        timeouts,
        idempotencyKey,
        executionId,
        yesIdempotencyKey,
        noIdempotencyKey,
        yesRecord,
        noRecord,
        trackedOrderIds,
        requiresUserChannel: preflight.requiresUserChannel
      }),
      Date.now()
    );
  }

  private applyPreflightEffects(effects: ExecutionPreflightEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'metric') {
        this.metrics?.record(effect.event);
      } else {
        this.incidentTracker?.record(effect.incident);
      }
    }
  }
}
