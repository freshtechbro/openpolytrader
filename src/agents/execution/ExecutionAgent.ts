import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import { isNearZeroRiskMode } from '../../config/policy.js';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../../config/risk.js';
import type { TradingMode } from '../../config/env.js';
import type { EventStore, StoredEvent } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';
import type { CircuitBreakerRegistry } from '../../core/CircuitBreaker.js';
import {
  buildFakSellOrder,
  buildFokBuyOrder,
  coerceOrderResponse,
  createInitialBasketExecutionState,
  createInitialExecutionState,
  getRequiredAction,
  isDelayedOrderResponse,
  isOrderFailure,
  type BasketExecutionLegState,
  toClobOrderPayload,
  transitionBasketExecutionState,
  transitionExecutionState,
  type ExecutionEvent,
  type ExecutionState,
  type PairedExecutionState,
  type UnwindResult
} from '../../domain/execution.js';
import type { IncidentReason } from '../../domain/incident.js';
import { createIdempotencyKey, type IdempotencyRecord } from '../../domain/idempotency.js';
import { fwOpportunityId, type ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { OrderResponse } from '../../domain/types.js';
import { PolymarketClob, type CancelOrdersResponse } from '../../services/PolymarketClob.js';
import type { PolymarketRealtime, UserOrderUpdate, UserTradeUpdate } from '../../services/PolymarketRealtime.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type { ExecutionAdvisor } from './ExecutionAdvisor.js';

export interface ExecutionResult {
  status: 'submitted' | 'failed' | 'blocked';
  reason?: string;
  yesOrder?: OrderResponse;
  noOrder?: OrderResponse;
  idempotencyKey: string;
  executionId: string;
  state: ExecutionState;
  basket?: {
    mode: 'batch_best_effort' | 'sequential_failfast';
    fallbackUsed?: boolean;
    legs: BasketExecutionLegState[];
  };
}

export interface ExecutionAgentConfig {
  tradingEnabled: boolean;
  tradingMode: TradingMode;
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

export interface ExecutionContext {
  yesBook?: OrderBookState;
  noBook?: OrderBookState;
  nowMs?: number;
}

interface ExecutionTimeouts {
  submitTimeoutMs: number;
  ackTimeoutMs: number;
  fillTimeoutMs: number;
  cancelTimeoutMs: number;
}

interface ObservedUserOrderState {
  orderId: string;
  marketId?: string;
  tokenId?: string;
  side?: 'BUY' | 'SELL';
  orderMatched?: number;
  tradeMatched: number;
  sizeMatched: number;
  originalSize?: number;
  status?: string;
  orderEventType?: string;
  price?: number;
  lastUpdateMs: number;
  cancelled: boolean;
}

interface UserFillOutcome {
  orderId: string;
  sizeMatched: number;
  fullyFilled: boolean;
  cancelled: boolean;
  timedOut: boolean;
  observedAtMs: number;
}

interface FillWaiter {
  desiredSize: number;
  resolve: (outcome: UserFillOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface BasketBatchOrderMetadata {
  marketId: string;
  side: 'yes' | 'no';
  idempotencyKey: string;
}

interface BasketBatchAcceptedOrder {
  marketId: string;
  side: 'yes' | 'no';
  idempotencyKey: string;
  orderId: string;
}

export class ExecutionAgent {
  private tradingEnabled: boolean;
  private tradingMode: TradingMode;
  private store?: EventStore;
  private riskConfig: RiskConfig;
  private portfolio?: PortfolioAgent;
  private userRealtime?: PolymarketRealtime;
  private circuitBreakers?: CircuitBreakerRegistry;
  private timeouts: ExecutionTimeouts;
  private executionAdvisor?: ExecutionAdvisor;
  private executionAdvisorMode: 'disabled' | 'shadow' | 'advisory' = 'disabled';
  private activeExecutions = new Map<string, PairedExecutionState>();
  private idempotencyCache = new Map<string, IdempotencyRecord>();
  private userOrders = new Map<string, ObservedUserOrderState>();
  private fillWaiters = new Map<string, FillWaiter[]>();
  private seenTradesByOrder = new Map<string, Set<string>>();

  constructor(
    private policy: TradePolicy,
    private clob: PolymarketClob,
    private incidentTracker?: IncidentTracker,
    private metrics?: MetricsStore,
    config?: ExecutionAgentConfig
  ) {
    this.tradingEnabled = config?.tradingEnabled ?? false;
    this.tradingMode = config?.tradingMode ?? 'off';
    this.store = config?.eventStore;
    this.riskConfig = config?.riskConfig ?? DEFAULT_RISK_CONFIG;
    this.portfolio = config?.portfolio;
    this.userRealtime = config?.userRealtime;
    this.circuitBreakers = config?.circuitBreakers;
    this.executionAdvisor = config?.executionAdvisor;
    this.executionAdvisorMode = config?.executionAdvisorMode ?? 'disabled';
    this.timeouts = {
      submitTimeoutMs: config?.submitTimeoutMs ?? policy.submitTimeoutMs,
      ackTimeoutMs: config?.ackTimeoutMs ?? policy.ackTimeoutMs,
      fillTimeoutMs: config?.fillTimeoutMs ?? policy.fillTimeoutMs,
      cancelTimeoutMs: config?.cancelTimeoutMs ?? policy.cancelTimeoutMs
    };

    if (this.userRealtime) {
      this.userRealtime.on('user:order', (event) => this.handleUserOrderUpdate(event as UserOrderUpdate));
      this.userRealtime.on('user:trade', (event) => this.handleUserTradeUpdate(event as UserTradeUpdate));
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

  private getEffectiveTimeouts(
    marketId: string,
    opportunityId: string,
    nowMs: number
  ): ExecutionTimeouts {
    const base = this.timeouts;
    const mode = this.executionAdvisorMode;
    const advisor = this.executionAdvisor;
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

    this.metrics?.record({
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

  private handleUserOrderUpdate(update: UserOrderUpdate): void {
    const orderId = update.orderId;
    const nowMs = Date.now();
    const previous = this.userOrders.get(orderId) ?? {
      orderId,
      marketId: undefined,
      tokenId: undefined,
      side: undefined,
      orderMatched: undefined,
      tradeMatched: 0,
      sizeMatched: 0,
      originalSize: undefined,
      status: undefined,
      orderEventType: undefined,
      price: undefined,
      lastUpdateMs: nowMs,
      cancelled: false
    };

    const marketId = update.marketId ?? previous.marketId;
    const tokenId = update.assetId ?? previous.tokenId;
    const side = normalizeOrderSide(update.side) ?? previous.side;
    const price = typeof update.price === 'number' ? update.price : previous.price;

    const orderMatched = typeof update.sizeMatched === 'number' ? update.sizeMatched : previous.orderMatched;
    const tradeMatched = previous.tradeMatched;
    const sizeMatched = Math.max(orderMatched ?? 0, tradeMatched);

    const next: ObservedUserOrderState = {
      ...previous,
      marketId,
      tokenId,
      side,
      orderMatched,
      tradeMatched,
      sizeMatched,
      originalSize: typeof update.originalSize === 'number' ? update.originalSize : previous.originalSize,
      status: update.status ?? previous.status,
      orderEventType: update.orderEventType ?? previous.orderEventType,
      price,
      lastUpdateMs: typeof update.timestampMs === 'number' ? update.timestampMs : nowMs,
      cancelled: previous.cancelled || isCancellationOrderUpdate(update)
    };

    this.userOrders.set(orderId, next);
    this.resolveFillWaiters(orderId);
  }

  private handleUserTradeUpdate(update: UserTradeUpdate): void {
    const nowMs = Date.now();

    const applyMatch = (orderId: string, tradeId: string, matchedAmount: number | undefined): void => {
      if (!matchedAmount || matchedAmount <= 0) return;
      const seen = this.seenTradesByOrder.get(orderId) ?? new Set<string>();
      if (seen.has(tradeId)) return;
      seen.add(tradeId);
      this.seenTradesByOrder.set(orderId, seen);

      const previous = this.userOrders.get(orderId) ?? {
        orderId,
        marketId: update.marketId,
        tokenId: update.assetId,
        side: normalizeOrderSide(update.side),
        orderMatched: undefined,
        tradeMatched: 0,
        sizeMatched: 0,
        originalSize: undefined,
        status: undefined,
        orderEventType: undefined,
        price: typeof update.price === 'number' ? update.price : undefined,
        lastUpdateMs: nowMs,
        cancelled: false
      };

      const tradeMatched = previous.tradeMatched + matchedAmount;
      const sizeMatched = Math.max(previous.orderMatched ?? 0, tradeMatched);
      const next: ObservedUserOrderState = {
        ...previous,
        tradeMatched,
        sizeMatched,
        lastUpdateMs: typeof update.timestampMs === 'number' ? update.timestampMs : nowMs
      };
      this.userOrders.set(orderId, next);
      this.resolveFillWaiters(orderId);
      this.recordPortfolioFillFromTrade(orderId, next, update, matchedAmount);
    };

    if (update.takerOrderId && typeof update.size === 'number') {
      applyMatch(update.takerOrderId, update.tradeId, update.size);
    }

    for (const maker of update.makerMatches) {
      applyMatch(maker.orderId, update.tradeId, maker.matchedAmount);
    }
  }

  private recordPortfolioFillFromTrade(
    orderId: string,
    orderState: ObservedUserOrderState,
    trade: UserTradeUpdate,
    matchedAmount: number
  ): void {
    if (!this.portfolio) return;

    const tokenId = orderState.tokenId ?? trade.assetId;
    const marketId = orderState.marketId ?? trade.marketId;
    const side = orderState.side ?? normalizeOrderSide(trade.side);
    const price = typeof trade.price === 'number' ? trade.price : orderState.price;

    if (!tokenId || !marketId || !side) return;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    if (matchedAmount <= 0 || !Number.isFinite(matchedAmount)) return;

    const timestamp =
      typeof trade.timestampMs === 'number' ? trade.timestampMs : Date.now();
    const priceTolerance = Math.max(this.policy.entrySlippageToleranceBps, 0) / 10000;

    this.portfolio.applyFillWithReconciliation(
      {
        tokenId,
        marketId,
        side,
        size: matchedAmount,
        price,
        timestamp
      },
      { sizeTolerance: 0, priceTolerance }
    );

    const expectedPrice =
      typeof orderState.price === 'number' && Number.isFinite(orderState.price) && orderState.price > 0
        ? orderState.price
        : undefined;
    const slippage =
      typeof expectedPrice === 'number' ? Math.abs(price - expectedPrice) / expectedPrice : undefined;

    messageBus.emit('execution:fill', {
      orderId,
      marketId,
      tokenId,
      side,
      size: matchedAmount,
      price,
      expectedPrice,
      slippage,
      at_ms: timestamp
    });
  }

  private waitForFillOutcome(orderId: string, desiredSize: number, timeoutMs: number): Promise<UserFillOutcome> {
    const immediate = this.deriveFillOutcome(orderId, desiredSize);
    if (immediate) return Promise.resolve(immediate);

    if (timeoutMs <= 0) {
      return Promise.resolve({
        orderId,
        sizeMatched: this.userOrders.get(orderId)?.sizeMatched ?? 0,
        fullyFilled: false,
        cancelled: false,
        timedOut: true,
        observedAtMs: Date.now()
      });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeFillWaiter(orderId, resolve);
        resolve({
          orderId,
          sizeMatched: this.userOrders.get(orderId)?.sizeMatched ?? 0,
          fullyFilled: false,
          cancelled: this.userOrders.get(orderId)?.cancelled ?? false,
          timedOut: true,
          observedAtMs: Date.now()
        });
      }, timeoutMs);

      const waiter: FillWaiter = { desiredSize, resolve, timeout };
      const waiters = this.fillWaiters.get(orderId) ?? [];
      waiters.push(waiter);
      this.fillWaiters.set(orderId, waiters);
    });
  }

  private deriveFillOutcome(orderId: string, desiredSize: number): UserFillOutcome | null {
    const state = this.userOrders.get(orderId);
    if (!state) return null;

    const observedAtMs = state.lastUpdateMs;
    const fullyFilled =
      state.sizeMatched >= desiredSize ||
      isFilledOrderStatus(state.status);

    if (fullyFilled) {
      return {
        orderId,
        sizeMatched: state.sizeMatched,
        fullyFilled: true,
        cancelled: state.cancelled,
        timedOut: false,
        observedAtMs
      };
    }

    if (state.cancelled) {
      return {
        orderId,
        sizeMatched: state.sizeMatched,
        fullyFilled: false,
        cancelled: true,
        timedOut: false,
        observedAtMs
      };
    }

    return null;
  }

  private resolveFillWaiters(orderId: string): void {
    const waiters = this.fillWaiters.get(orderId);
    if (!waiters || waiters.length === 0) return;

    const remaining: FillWaiter[] = [];
    for (const waiter of waiters) {
      const outcome = this.deriveFillOutcome(orderId, waiter.desiredSize);
      if (outcome) {
        clearTimeout(waiter.timeout);
        waiter.resolve(outcome);
      } else {
        remaining.push(waiter);
      }
    }

    if (remaining.length > 0) {
      this.fillWaiters.set(orderId, remaining);
    } else {
      this.fillWaiters.delete(orderId);
    }
  }

  private removeFillWaiter(orderId: string, resolve: (outcome: UserFillOutcome) => void): void {
    const waiters = this.fillWaiters.get(orderId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
    if (remaining.length > 0) {
      this.fillWaiters.set(orderId, remaining);
    } else {
      this.fillWaiters.delete(orderId);
    }
  }

  private cleanupOrderTracking(orderIds: string[]): void {
    for (const orderId of orderIds) {
      const waiters = this.fillWaiters.get(orderId);
      if (waiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
        }
        this.fillWaiters.delete(orderId);
      }
      this.userOrders.delete(orderId);
      this.seenTradesByOrder.delete(orderId);
    }
  }

  async executeBasketArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    const nowMs = context?.nowMs ?? Date.now();
    const idempotencyKey = createIdempotencyKey(`${opportunity.id}:basket:${size.toFixed(8)}`);
    const executionId = `${idempotencyKey}:basket`;

    if (opportunity.type !== 'fw_basket' || !opportunity.fwBasket || opportunity.fwBasket.markets.length === 0) {
      return {
        status: 'blocked',
        reason: 'fw_basket_missing',
        idempotencyKey,
        executionId,
        state: 'idle'
      };
    }

    const mode = opportunity.fwBasket.executionMode ?? this.policy.fwBasketExecutionMode;
    const legs = opportunity.fwBasket.markets;
    this.ensureIdempotencyRecord(idempotencyKey, nowMs);
    let basketState = createInitialBasketExecutionState({
      id: executionId,
      opportunityId: opportunity.id,
      markets: legs.map((leg) => ({
        marketId: leg.marketId,
        yesTokenId: leg.yesTokenId,
        noTokenId: leg.noTokenId
      })),
      createdAtMs: nowMs
    });
    const applyBasketEvent = (event: Parameters<typeof transitionBasketExecutionState>[1]): void => {
      basketState = transitionBasketExecutionState(basketState, event);
    };
    const finalizeBasketFailure = (
      reason: string,
      atMs = Date.now(),
      finalMode: 'batch_best_effort' | 'sequential_failfast' = mode,
      fallbackUsed = false
    ): ExecutionResult => {
      this.markIdempotencyFailed(idempotencyKey, atMs);
      applyBasketEvent({ type: 'FAILED', atMs, reason });
      this.metrics?.record({
        type: 'fw_basket',
        timestamp: atMs,
        data: {
          event: 'basket_failed',
          basketId: opportunity.fwBasket?.basketId,
          reason,
          mode,
          markets: legs.length
        }
      });
      return {
        status: 'failed',
        reason,
        idempotencyKey,
        executionId,
        state: 'failed',
        basket: { mode: finalMode, fallbackUsed, legs: basketState.legs }
      };
    };
    const finalizeBasketSuccess = (
      finalMode: 'batch_best_effort' | 'sequential_failfast',
      fallbackUsed: boolean,
      atMs = Date.now()
    ): ExecutionResult => {
      const record = this.getIdempotencyRecord(idempotencyKey);
      if (record) {
        this.saveIdempotencyRecord({
          ...record,
          status: 'confirmed',
          updatedAt: atMs
        });
      }
      applyBasketEvent({ type: 'COMPLETE', atMs });
      this.metrics?.record({
        type: 'fw_basket',
        timestamp: atMs,
        data: {
          event: 'basket_complete',
          basketId: opportunity.fwBasket?.basketId,
          mode: finalMode,
          fallbackUsed,
          markets: legs.length
        }
      });
      return {
        status: 'submitted',
        idempotencyKey,
        executionId,
        state: 'complete',
        basket: { mode: finalMode, fallbackUsed, legs: basketState.legs }
      };
    };

    if (mode === 'batch_best_effort') {
      const batch = await this.trySubmitBasketBatch(opportunity, size, nowMs, idempotencyKey);
      basketState = {
        ...basketState,
        legs: basketState.legs.map((currentLeg) => {
          const nextLeg = batch.legs.find((candidate) => candidate.marketId === currentLeg.marketId);
          return nextLeg ? { ...currentLeg, ...nextLeg } : currentLeg;
        })
      };
      for (const leg of batch.legs) {
        if (leg.state === 'blocked') continue;
        if (leg.state === 'failed') {
          applyBasketEvent({
            type: 'LEG_FAILED',
            atMs: nowMs,
            marketId: leg.marketId,
            reason: leg.reason
          });
          continue;
        }
        applyBasketEvent({ type: 'LEG_SUBMITTED', atMs: nowMs, marketId: leg.marketId });
        if (leg.state === 'acked' || leg.state === 'filled') {
          applyBasketEvent({ type: 'LEG_ACKED', atMs: nowMs, marketId: leg.marketId });
        }
      }

      if (batch.outcome === 'submitted') {
        if (this.userRealtime?.isConnected() && this.timeouts.fillTimeoutMs > 0 && batch.acceptedOrders.length > 0) {
          const wait = await this.waitForBatchFillOutcomes(
            batch.acceptedOrders,
            size,
            this.timeouts.fillTimeoutMs
          );
          if (!wait.allFilled) {
            applyBasketEvent({ type: 'PARTIAL_FILL', atMs: wait.observedAtMs, reason: 'partial_fill' });
            await this.cancelOutstandingBatchOrders(wait.outcomes, opportunity.id, wait.observedAtMs);

            const filledMarketIds = Array.from(
              new Set(
                wait.outcomes
                  .filter(({ outcome }) => outcome.fullyFilled || outcome.sizeMatched > 0)
                  .map(({ order }) => order.marketId)
              )
            );
            const filledLegs = legs.filter((leg) => filledMarketIds.includes(leg.marketId));
            if (filledLegs.length > 0) {
              applyBasketEvent({ type: 'START_UNWIND', atMs: wait.observedAtMs });
              await this.unwindBasketLegs(opportunity, filledLegs, size, wait.observedAtMs);
            }
            return finalizeBasketFailure('partial_fill', wait.observedAtMs, mode, false);
          }

          for (const accepted of batch.acceptedOrders) {
            applyBasketEvent({ type: 'LEG_FILLED', atMs: wait.observedAtMs, marketId: accepted.marketId });
            const existing = this.getIdempotencyRecord(accepted.idempotencyKey);
            if (existing) {
              this.saveIdempotencyRecord({
                ...existing,
                orderId: accepted.orderId,
                status: 'confirmed',
                updatedAt: wait.observedAtMs
              });
            }
          }
          return finalizeBasketSuccess(mode, false, wait.observedAtMs);
        }

        return finalizeBasketSuccess(mode, false, nowMs);
      }
      if (batch.outcome === 'partial') {
        return finalizeBasketFailure('batch_partial_accepted', nowMs, mode, false);
      }
    }

    const successfulLegs: typeof legs = [];
    for (const leg of legs) {
      const legOpportunity = this.toBasketLegOpportunity(opportunity, leg, nowMs);
      const legResult = await this.executeArbitrage(legOpportunity, size, { nowMs });
      const legState: BasketExecutionLegState = {
        marketId: leg.marketId,
        yesTokenId: leg.yesTokenId,
        noTokenId: leg.noTokenId,
        state:
          legResult.status === 'submitted'
            ? 'filled'
            : legResult.status === 'blocked'
              ? 'blocked'
              : 'failed',
        executionId: legResult.executionId,
        idempotencyKey: legResult.idempotencyKey,
        reason: legResult.reason
      };
      basketState = {
        ...basketState,
        legs: basketState.legs.map((currentLeg) =>
          currentLeg.marketId === leg.marketId ? { ...currentLeg, ...legState } : currentLeg
        )
      };
      if (legResult.status === 'submitted') {
        applyBasketEvent({ type: 'LEG_FILLED', atMs: nowMs, marketId: leg.marketId });
      } else if (legResult.status === 'blocked') {
        applyBasketEvent({ type: 'LEG_CANCELLED', atMs: nowMs, marketId: leg.marketId, reason: legResult.reason });
      } else {
        applyBasketEvent({ type: 'LEG_FAILED', atMs: nowMs, marketId: leg.marketId, reason: legResult.reason });
      }

      if (legResult.status === 'submitted') {
        successfulLegs.push(leg);
        continue;
      }

      if (successfulLegs.length > 0) {
        applyBasketEvent({ type: 'PARTIAL_FILL', atMs: nowMs, reason: 'partial_fill' });
        applyBasketEvent({ type: 'START_UNWIND', atMs: nowMs });
        await this.unwindBasketLegs(opportunity, successfulLegs, size, nowMs);
        return finalizeBasketFailure(
          'partial_fill',
          nowMs,
          'sequential_failfast',
          mode === 'batch_best_effort'
        );
      }

      return finalizeBasketFailure(
        legResult.reason ?? 'order_failed',
        nowMs,
        'sequential_failfast',
        mode === 'batch_best_effort'
      );
    }

    return finalizeBasketSuccess('sequential_failfast', mode === 'batch_best_effort', nowMs);
  }

  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    const nowMs = context?.nowMs ?? Date.now();
    const isEv = opportunity.type === 'ev';
    const idempotencyKey = createIdempotencyKey(
      `${opportunity.marketId}:${opportunity.yesTokenId}:${opportunity.noTokenId}:${opportunity.detectedAt}`
    );
    const executionId = idempotencyKey;
    const idleState: ExecutionState = 'idle';
    const trackedOrderIds: string[] = [];
    const finalize = (result: ExecutionResult, atMs = Date.now()) => {
      this.emitExecutionOutcome(opportunity, result, atMs);
      if (trackedOrderIds.length > 0) {
        this.cleanupOrderTracking(trackedOrderIds);
      }
      return result;
    };

    if (isEv && !opportunity.side) {
      return finalize(
        { status: 'blocked', reason: 'ev_missing_side', idempotencyKey, executionId, state: idleState },
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
        { status: 'blocked', reason: 'circuit_breaker', idempotencyKey, executionId, state: idleState },
        nowMs
      );
    }
    const timeouts = this.getEffectiveTimeouts(opportunity.marketId, opportunity.id, nowMs);
    const yesIdempotencyKey = `${idempotencyKey}:yes`;
    const noIdempotencyKey = `${idempotencyKey}:no`;

    this.pruneIdempotencyRecords(nowMs - this.policy.orderToTradeWindowMs);
    const yesRecord = this.ensureIdempotencyRecord(yesIdempotencyKey, nowMs);
    const noRecord = this.ensureIdempotencyRecord(noIdempotencyKey, nowMs);

    const cancelLeg = async (
      leg: 'yes' | 'no',
      order: OrderResponse | undefined,
      tokenId: string
    ): Promise<{
      ok: boolean;
      leg: 'yes' | 'no';
      scope: 'order' | 'market';
      orderId?: string;
      response?: CancelOrdersResponse;
      error?: string;
    }> => {
      const orderId = extractOrderId(order);
      const scope: 'order' | 'market' = orderId ? 'order' : 'market';
      try {
        const response = orderId
          ? await withTimeout(
              this.clob.cancelOrder(orderId),
              timeouts.cancelTimeoutMs,
              `cancel_${leg}`
            )
          : await withTimeout(
              this.clob.cancelMarketOrders({ assetId: tokenId }),
              timeouts.cancelTimeoutMs,
              `cancel_${leg}`
            );
        const failed = isCancelFailure(response, orderId);
        return { ok: !failed, leg, scope, orderId, response };
      } catch (error) {
        return {
          ok: false,
          leg,
          scope,
          orderId,
          error: formatCancelError(error)
        };
      }
    };

    const failWithCancel = async (
      current: PairedExecutionState,
      atMs: number,
      resultReason: string,
      incidentReason: IncidentReason,
      detail: Record<string, unknown>,
      yesOrder?: OrderResponse,
      noOrder?: OrderResponse
    ): Promise<ExecutionResult> => {
      let next = current;
      if (current.state !== 'cancelling') {
        next = this.transition(current, { type: 'CANCEL_STARTED', atMs });
      }

      const [yesCancel, noCancel] = await Promise.all([
        cancelLeg('yes', yesOrder, opportunity.yesTokenId),
        cancelLeg('no', noOrder, opportunity.noTokenId)
      ]);
      const cancelDetail = {
        cancelTimeoutMs: timeouts.cancelTimeoutMs,
        yes: yesCancel,
        no: noCancel
      };

      this.markIdempotencyFailed(yesIdempotencyKey, atMs);
      this.markIdempotencyFailed(noIdempotencyKey, atMs);

      if (!yesCancel.ok || !noCancel.ok) {
        this.incidentTracker?.record({
          marketId: opportunity.marketId,
          reason: 'order_cancel_failed',
          timestamp: atMs,
          opportunityId: opportunity.id,
          detail: cancelDetail
        });
      }

      next = this.transition(next, { type: 'FAILED', atMs, reason: resultReason });
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: incidentReason,
        timestamp: atMs,
        opportunityId: opportunity.id,
        detail: { ...detail, cancel: cancelDetail, cancelTimeoutMs: timeouts.cancelTimeoutMs }
      });
      return {
        status: 'failed',
        reason: resultReason,
        yesOrder,
        noOrder,
        idempotencyKey,
        executionId,
        state: next.state
      };
    };

    const resolvePartialFillLeg = (
      yesOrder?: OrderResponse,
      noOrder?: OrderResponse
    ): 'yes' | 'no' | null => {
      const yesOk = isOrderSuccessful(yesOrder);
      const noOk = isOrderSuccessful(noOrder);
      if (yesOk && !noOk) return 'yes';
      if (noOk && !yesOk) return 'no';
      return null;
    };

    const handleUnwind = async (
      current: PairedExecutionState,
      filledLeg: 'yes' | 'no',
      entryPrice: number,
      tickSize: number,
      unwindSize: number
    ): Promise<{ state: PairedExecutionState; result: UnwindResult }> => {
      const tokenId = filledLeg === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;
      const unwindPrice = this.calculateUnwindPrice(entryPrice, tickSize, {
        marketId: opportunity.marketId,
        opportunityId: opportunity.id
      });
      const clientOrderId = `${idempotencyKey}:${filledLeg}:unwind`;
      const unwindOrder = buildFakSellOrder({
        tokenId,
        size: unwindSize,
        price: unwindPrice,
        clientOrderId
      });

      let state = this.transition(current, { type: 'START_UNWIND', atMs: Date.now() });
      try {
        const response = await withTimeout(
          this.clob.createOrder(toClobOrderPayload(unwindOrder)),
          timeouts.submitTimeoutMs,
          `unwind_${filledLeg}`
        );
        const order = coerceOrderResponse(response);
        const ok = isOrderSuccessful(order);
        const finishMs = Date.now();
        if (!ok) {
          state = this.transition(state, { type: 'FAILED', atMs: finishMs, reason: 'unwind_failed' });
          return {
            state,
            result: {
              ok: false,
              leg: filledLeg,
              price: unwindPrice,
              size: unwindSize,
              order,
              error: 'unwind_failed'
            }
          };
        }
        state = this.transition(state, { type: 'UNWIND_COMPLETE', atMs: finishMs });
        state = this.transition(state, { type: 'COMPLETE', atMs: finishMs });
        return {
          state,
          result: {
            ok: true,
            leg: filledLeg,
            price: unwindPrice,
            size: unwindSize,
            order
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishMs = Date.now();
        state = this.transition(state, { type: 'FAILED', atMs: finishMs, reason: 'unwind_failed' });
        return {
          state,
          result: {
            ok: false,
            leg: filledLeg,
            price: unwindPrice,
            size: unwindSize,
            error: message
          }
        };
      }
    };

    const handlePartialFill = async (
      current: PairedExecutionState,
      atMs: number,
      filledLeg: 'yes' | 'no',
      filledSize: number,
      failureReason: string,
      failureDetail: Record<string, unknown>,
      yesOrder?: OrderResponse,
      noOrder?: OrderResponse
    ): Promise<ExecutionResult> => {
      const unfilledLeg = filledLeg === 'yes' ? 'no' : 'yes';
      const unfilledOrder = filledLeg === 'yes' ? noOrder : yesOrder;
      const unfilledTokenId =
        filledLeg === 'yes' ? opportunity.noTokenId : opportunity.yesTokenId;
      const entryPrice = filledLeg === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
      const tokenId = filledLeg === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;

      let state = this.transition(
        current,
        filledLeg === 'yes' ? { type: 'FILL_YES', atMs } : { type: 'FILL_NO', atMs }
      );
      state = this.transition(state, { type: 'PARTIAL_FILL', atMs });

      const cancelResult = await cancelLeg(unfilledLeg, unfilledOrder, unfilledTokenId);
      if (!cancelResult.ok) {
        this.incidentTracker?.record({
          marketId: opportunity.marketId,
          reason: 'order_cancel_failed',
          timestamp: atMs,
          opportunityId: opportunity.id,
          detail: { cancel: cancelResult, filledLeg, unfilledLeg }
        });
      }

      this.markIdempotencyFailed(yesIdempotencyKey, atMs);
      this.markIdempotencyFailed(noIdempotencyKey, atMs);

      const tickSize = this.resolveUnwindTickSize(filledLeg, opportunity, context);
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'partial_fill',
        timestamp: atMs,
        opportunityId: opportunity.id,
        detail: {
          filledLeg,
          unfilledLeg,
          failureReason,
          failureDetail,
          cancel: cancelResult,
          tickSize
        }
      });
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'unwind_triggered',
        timestamp: atMs,
        opportunityId: opportunity.id,
        detail: { filledLeg, entryPrice, tickSize, filledSize }
      });

      const unwind = await handleUnwind(state, filledLeg, entryPrice, tickSize, filledSize);
      state = unwind.state;

      if (!unwind.result.ok) {
        this.incidentTracker?.record({
          marketId: opportunity.marketId,
          reason: 'unwind_failed',
          timestamp: Date.now(),
          opportunityId: opportunity.id,
          recoveryAction: 'block',
          detail: {
            filledLeg,
            entryPrice,
            tickSize,
            failureReason,
            failureDetail,
            cancel: cancelResult,
            unwind: unwind.result
          }
        });
        return {
          status: 'failed',
          reason: 'unwind_failed',
          yesOrder,
          noOrder,
          idempotencyKey,
          executionId,
          state: state.state
        };
      }

      this.recordUnwindPortfolio(
        opportunity.marketId,
        tokenId,
        entryPrice,
        unwind.result.price,
        filledSize
      );

      return {
        status: 'failed',
        reason: 'partial_fill',
        yesOrder,
        noOrder,
        idempotencyKey,
        executionId,
        state: state.state
      };
    };

    const handleFailure = async (
      current: PairedExecutionState,
      atMs: number,
      resultReason: string,
      incidentReason: IncidentReason,
      detail: Record<string, unknown>,
      yesOrder?: OrderResponse,
      noOrder?: OrderResponse
    ): Promise<ExecutionResult> => {
      const filledLeg = resolvePartialFillLeg(yesOrder, noOrder);
      if (!filledLeg) {
        return failWithCancel(current, atMs, resultReason, incidentReason, detail, yesOrder, noOrder);
      }
      return handlePartialFill(
        current,
        atMs,
        filledLeg,
        size,
        resultReason,
        detail,
        yesOrder,
        noOrder
      );
    };

    if (!this.tradingEnabled) {
      return finalize(
        {
          status: 'blocked',
          reason: 'trading_disabled',
          idempotencyKey,
          executionId,
          state: idleState
        },
        nowMs
      );
    }

    if (this.tradingMode !== 'live') {
      const reason =
        this.tradingMode === 'shadow'
          ? 'shadow_mode'
          : this.tradingMode === 'paper'
            ? 'paper_mode'
            : 'trading_mode_off';
      if (this.tradingMode === 'shadow') {
        this.metrics?.record({
          type: 'shadow_decision',
          timestamp: Date.now(),
          data: { marketId: opportunity.marketId, opportunityId: opportunity.id, reason }
        });
      }
      return finalize(
        {
          status: 'blocked',
          reason,
          idempotencyKey,
          executionId,
          state: idleState
        },
        nowMs
      );
    }

    const requiresUserChannel = isNearZeroRiskMode(this.policy) || isEv;
    if (requiresUserChannel) {
      if (!this.userRealtime) {
        return finalize(
          {
            status: 'blocked',
            reason: 'user_channel_unconfigured',
            idempotencyKey,
            executionId,
            state: idleState
          },
          nowMs
        );
      }
      if (!this.userRealtime.isConnected()) {
        return finalize(
          {
            status: 'blocked',
            reason: 'user_channel_disconnected',
            idempotencyKey,
            executionId,
            state: idleState
          },
          nowMs
        );
      }
    }

    if (!isEv && this.policy.rejectDelayed === false) {
      throw new Error('ExecutionAgent requires rejectDelayed=true for near-risk-free mode');
    }
    const decisionLatencyMs = nowMs - opportunity.detectedAt;
    if (this.policy.maxDecisionLatencyMs > 0 && decisionLatencyMs > this.policy.maxDecisionLatencyMs) {
      this.metrics?.record({
        type: 'slo_violation',
        timestamp: nowMs,
        data: {
          sloName: 'decision_latency',
          threshold: this.policy.maxDecisionLatencyMs,
          actual: decisionLatencyMs,
          marketId: opportunity.marketId,
          timestampMs: nowMs
        }
      });
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'latency_exceeded',
        timestamp: nowMs,
        opportunityId: opportunity.id,
        detail: { decisionLatencyMs, maxDecisionLatencyMs: this.policy.maxDecisionLatencyMs }
      });
      return finalize(
        {
          status: 'blocked',
          reason: 'decision_latency_exceeded',
          idempotencyKey,
          executionId,
          state: idleState
        },
        nowMs
      );
    }
    const plannedOrders = isEv ? 1 : 2;

    if (this.metrics) {
      const otrWindowMs = this.policy.orderToTradeWindowMs;
      const stats = this.metrics.getOrderStats(opportunity.marketId, otrWindowMs, nowMs);
      const projectedRatio = (stats.orders + plannedOrders) / Math.max(stats.fills, 1);
      if (projectedRatio > this.policy.maxOrderToTradeRatio) {
        this.incidentTracker?.record({
          marketId: opportunity.marketId,
          reason: 'otr_exceeded',
          timestamp: nowMs,
          opportunityId: opportunity.id,
          detail: {
            windowMs: otrWindowMs,
            orders: stats.orders,
            fills: stats.fills,
            projectedRatio,
            maxOrderToTradeRatio: this.policy.maxOrderToTradeRatio
          }
        });
        return finalize(
          { status: 'blocked', reason: 'otr_exceeded', idempotencyKey, executionId, state: idleState },
          nowMs
        );
      }

      if (this.policy.maxOrdersPerMinute > 0) {
        const velocityWindowMs = this.policy.orderVelocityWindowMs;
        const currentOrders = this.metrics.getOrderVelocity(velocityWindowMs, nowMs);
        const projectedOrders = currentOrders + plannedOrders;
        if (projectedOrders > this.policy.maxOrdersPerMinute) {
          this.metrics.record({
            type: 'slo_violation',
            timestamp: nowMs,
            data: {
              sloName: 'order_velocity',
              threshold: this.policy.maxOrdersPerMinute,
              actual: projectedOrders,
              windowMs: velocityWindowMs,
              marketId: opportunity.marketId,
              timestampMs: nowMs
            }
          });
          this.incidentTracker?.record({
            marketId: opportunity.marketId,
            reason: 'velocity_throttle',
            timestamp: nowMs,
            opportunityId: opportunity.id,
            detail: {
              windowMs: velocityWindowMs,
              orders: currentOrders,
              projectedOrders,
              maxOrdersPerMinute: this.policy.maxOrdersPerMinute
            }
          });
          return finalize(
            { status: 'blocked', reason: 'velocity_throttle', idempotencyKey, executionId, state: idleState },
            nowMs
          );
        }
      }

      if (this.policy.maxDelayedAckRate > 0) {
        const delayedAckRate = this.metrics.getDelayedAckRate(
          opportunity.marketId,
          otrWindowMs,
          nowMs
        );
        if (delayedAckRate > this.policy.maxDelayedAckRate) {
          this.metrics.record({
            type: 'slo_violation',
            timestamp: nowMs,
            data: {
              sloName: 'delayed_ack_rate',
              threshold: this.policy.maxDelayedAckRate,
              actual: delayedAckRate,
              marketId: opportunity.marketId,
              timestampMs: nowMs
            }
          });
          this.incidentTracker?.record({
            marketId: opportunity.marketId,
            reason: 'latency_exceeded',
            timestamp: nowMs,
            opportunityId: opportunity.id,
            detail: {
              delayedAckRate,
              maxDelayedAckRate: this.policy.maxDelayedAckRate,
              windowMs: otrWindowMs
            }
          });
          return finalize(
            {
              status: 'blocked',
              reason: 'delayed_ack_rate_exceeded',
              idempotencyKey,
              executionId,
              state: idleState
            },
            nowMs
          );
        }
      }
    }

    const yesBestAsk = context?.yesBook?.bestAsk;
    const noBestAsk = context?.noBook?.bestAsk;
    if (yesBestAsk && noBestAsk) {
      const bandFraction = this.policy.priceBandBps / 10000;

      if (isEv && opportunity.side) {
        const sideBestAsk = opportunity.side === 'yes' ? yesBestAsk : noBestAsk;
        const expected = opportunity.side === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
        const deviation = expected > 0 ? Math.abs(sideBestAsk.price - expected) / expected : 0;
        if (deviation > bandFraction) {
          this.incidentTracker?.record({
            marketId: opportunity.marketId,
            reason: 'price_moved',
            timestamp: nowMs,
            opportunityId: opportunity.id,
            detail: {
              side: opportunity.side,
              deviation,
              bandFraction,
              observed: sideBestAsk.price,
              expected
            }
          });
          return finalize(
            { status: 'blocked', reason: 'price_moved', idempotencyKey, executionId, state: idleState },
            nowMs
          );
        }
      } else {
        const yesDeviation =
          opportunity.yesPrice > 0
            ? Math.abs(yesBestAsk.price - opportunity.yesPrice) / opportunity.yesPrice
            : 0;
        const noDeviation =
          opportunity.noPrice > 0
            ? Math.abs(noBestAsk.price - opportunity.noPrice) / opportunity.noPrice
            : 0;

        if (yesDeviation > bandFraction || noDeviation > bandFraction) {
          this.incidentTracker?.record({
            marketId: opportunity.marketId,
            reason: 'price_moved',
            timestamp: nowMs,
            opportunityId: opportunity.id,
            detail: {
              yesDeviation,
              noDeviation,
              bandFraction,
              yesObserved: yesBestAsk.price,
              noObserved: noBestAsk.price,
              yesExpected: opportunity.yesPrice,
              noExpected: opportunity.noPrice
            }
          });
          return finalize(
            { status: 'blocked', reason: 'price_moved', idempotencyKey, executionId, state: idleState },
            nowMs
          );
        }
      }
    }

    if (isEv) {
      const evResult = await this.executeEvOrder(opportunity, size, context, {
        nowMs,
        idempotencyKey,
        executionId,
        idleState,
        timeouts,
        yesIdempotencyKey,
        noIdempotencyKey,
        yesRecord,
        noRecord,
        trackedOrderIds,
        requiresUserChannel
      });
      return finalize(evResult, Date.now());
    }

    const detectedAt = opportunity.detectedAt;
    const initialState = createInitialExecutionState({
      id: executionId,
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      yesTokenId: opportunity.yesTokenId,
      noTokenId: opportunity.noTokenId,
      size,
      yesPrice: opportunity.yesPrice,
      noPrice: opportunity.noPrice,
      createdAtMs: nowMs
    });
    this.activeExecutions.set(initialState.id, initialState);

    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'detected',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: detectedAt,
        latencyMs: 0,
        cumulativeMs: 0
      });
    }

    let state = this.transition(initialState, { type: 'SUBMIT_STARTED', atMs: nowMs });

    if (this.portfolio) {
      this.portfolio.expectFill({
        opportunityId: opportunity.id,
        tokenId: opportunity.yesTokenId,
        expectedSize: size,
        expectedPrice: opportunity.yesPrice,
        timestamp: nowMs
      });
      this.portfolio.expectFill({
        opportunityId: opportunity.id,
        tokenId: opportunity.noTokenId,
        expectedSize: size,
        expectedPrice: opportunity.noPrice,
        timestamp: nowMs
      });
    }

    const submitMs = Date.now();
    state = this.transition(state, { type: 'SUBMIT_YES', atMs: submitMs });
    state = this.transition(state, { type: 'SUBMIT_NO', atMs: submitMs });

    const yesPayload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId: opportunity.yesTokenId,
        size,
        price: opportunity.yesPrice,
        clientOrderId: yesIdempotencyKey
      })
    );

    const noPayload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId: opportunity.noTokenId,
        size,
        price: opportunity.noPrice,
        clientOrderId: noIdempotencyKey
      })
    );

    const yesPayloadWithNonce = {
      ...yesPayload,
      nonce: coerceNonceValue(yesRecord.nonce)
    };
    const noPayloadWithNonce = {
      ...noPayload,
      nonce: coerceNonceValue(noRecord.nonce)
    };

    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'submitted',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: submitMs,
        latencyMs: submitMs - detectedAt,
        cumulativeMs: submitMs - detectedAt
      });
    }

    if (this.metrics) {
      this.metrics.recordOrderAttempt(opportunity.marketId, nowMs);
      this.metrics.recordOrderAttempt(opportunity.marketId, nowMs);
    }

    const submitLeg = async (
      payload: Record<string, unknown>,
      record: IdempotencyRecord
    ): Promise<{ response: unknown; ackMs: number; reused: boolean }> => {
      if (record.status !== 'failed' && record.orderId) {
        return {
          response: { status: 'LIVE', success: true },
          ackMs: Date.now(),
          reused: true
        };
      }

      const response = await this.clob.createOrder(payload);
      return { response, ackMs: Date.now(), reused: false };
    };

    const yesPromise = withTimeout(
      submitLeg(yesPayloadWithNonce, yesRecord),
      timeouts.submitTimeoutMs,
      'submit_yes'
    );
    const noPromise = withTimeout(
      submitLeg(noPayloadWithNonce, noRecord),
      timeouts.submitTimeoutMs,
      'submit_no'
    );

    const results = await Promise.allSettled([yesPromise, noPromise]);
    const yesResult = results[0];
    const noResult = results[1];
    const timeoutFailure = results.find(
      (result) => result.status === 'rejected' && isTimeoutError(result.reason)
    ) as PromiseRejectedResult | undefined;
    const rejectionFailure = results.find(
      (result) => result.status === 'rejected' && !isTimeoutError(result.reason)
    ) as PromiseRejectedResult | undefined;

    if (timeoutFailure || rejectionFailure) {
      const timeoutError = timeoutFailure?.reason;
      const message =
        rejectionFailure?.reason instanceof Error
          ? rejectionFailure.reason.message
          : String(rejectionFailure?.reason ?? 'order_failed');
      const detail = isTimeoutError(timeoutError)
        ? { phase: timeoutError.phase, timeoutMs: timeoutError.timeoutMs }
        : { error: message };
      const yesResponse =
        yesResult.status === 'fulfilled' ? coerceOrderResponse(yesResult.value.response) : undefined;
      const noResponse =
        noResult.status === 'fulfilled' ? coerceOrderResponse(noResult.value.response) : undefined;
      const incidentReason: IncidentReason = isTimeoutError(timeoutError)
        ? 'order_timeout'
        : 'order_failed';
      const resultReason = incidentReason;
      const failureAtMs = Date.now();
      return finalize(
        await handleFailure(state, failureAtMs, resultReason, incidentReason, detail, yesResponse, noResponse),
        failureAtMs
      );
    }

    const [yesFulfilled, noFulfilled] = results as [
      PromiseFulfilledResult<{ response: unknown; ackMs: number; reused: boolean }>,
      PromiseFulfilledResult<{ response: unknown; ackMs: number; reused: boolean }>
    ];

    const { response: yesOrder, ackMs: yesAckMs } = yesFulfilled.value;
    const { response: noOrder, ackMs: noAckMs } = noFulfilled.value;

    let yesResponse = coerceOrderResponse(yesOrder);
    let noResponse = coerceOrderResponse(noOrder);

    const yesOrderId = extractOrderId(yesResponse) ?? yesRecord.orderId;
    const noOrderId = extractOrderId(noResponse) ?? noRecord.orderId;
    trackedOrderIds.length = 0;
    if (yesOrderId) trackedOrderIds.push(yesOrderId);
    if (noOrderId) trackedOrderIds.push(noOrderId);

    if (yesOrderId && !extractOrderId(yesResponse)) {
      yesResponse = { ...yesResponse, orderID: yesOrderId };
    }
    if (noOrderId && !extractOrderId(noResponse)) {
      noResponse = { ...noResponse, orderID: noOrderId };
    }

    this.saveIdempotencyRecord({
      ...yesRecord,
      orderId: yesOrderId,
      status: yesOrderId ? 'submitted' : yesRecord.status,
      updatedAt: yesAckMs
    });
    this.saveIdempotencyRecord({
      ...noRecord,
      orderId: noOrderId,
      status: noOrderId ? 'submitted' : noRecord.status,
      updatedAt: noAckMs
    });

    state = this.transition(state, { type: 'ACK_YES', atMs: yesAckMs, order: yesResponse });
    state = this.transition(state, { type: 'ACK_NO', atMs: noAckMs, order: noResponse });

    if (this.metrics) {
      if (isDelayedOrderResponse(yesOrder)) this.metrics.recordDelayedAck(opportunity.marketId, yesAckMs);
      if (isDelayedOrderResponse(noOrder)) this.metrics.recordDelayedAck(opportunity.marketId, noAckMs);
    }

    const ackStageMs = Math.max(yesAckMs, noAckMs);
    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'acked',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: ackStageMs,
        latencyMs: ackStageMs - submitMs,
        cumulativeMs: ackStageMs - detectedAt
      });
    }

    const ackLatencyMs = ackStageMs - submitMs;
    if (timeouts.ackTimeoutMs > 0 && ackLatencyMs > timeouts.ackTimeoutMs) {
      return finalize(
        await handleFailure(
          state,
          ackStageMs,
          'order_timeout',
          'order_timeout',
          { phase: 'ack', ackLatencyMs, ackTimeoutMs: timeouts.ackTimeoutMs },
          yesResponse,
          noResponse
        ),
        ackStageMs
      );
    }

    if (isDelayedOrderResponse(yesOrder) || isDelayedOrderResponse(noOrder)) {
      return finalize(
        await handleFailure(
          state,
          ackStageMs,
          'order_delayed',
          'order_delayed',
          { yesOrder, noOrder },
          yesResponse,
          noResponse
        ),
        ackStageMs
      );
    }

    if (isOrderFailure(yesOrder) || isOrderFailure(noOrder)) {
      return finalize(
        await handleFailure(
          state,
          ackStageMs,
          'order_rejected',
          'order_rejected',
          { yesOrder, noOrder },
          yesResponse,
          noResponse
        ),
        ackStageMs
      );
    }

    const legSkewMs = Math.abs(yesAckMs - noAckMs);
    if (this.policy.maxLegSkewMs > 0 && legSkewMs > this.policy.maxLegSkewMs) {
      return finalize(
        await handleFailure(
          state,
          ackStageMs,
          'leg_skew_exceeded',
          'latency_exceeded',
          {
            legSkewMs,
            maxLegSkewMs: this.policy.maxLegSkewMs,
            yesAckMs,
            noAckMs
          },
          yesResponse,
          noResponse
        ),
        ackStageMs
      );
    }

    const remainingFillTimeoutMs =
      timeouts.fillTimeoutMs > 0 ? Math.max(0, timeouts.fillTimeoutMs - (Date.now() - ackStageMs)) : 0;

    if (requiresUserChannel && remainingFillTimeoutMs > 0) {
      if (!yesOrderId || !noOrderId) {
        const failureAtMs = Date.now();
        return finalize(
          await handleFailure(
            state,
            failureAtMs,
            'order_failed',
            'order_failed',
            { yesOrderId, noOrderId },
            yesResponse,
            noResponse
          ),
          failureAtMs
        );
      }

      const [yesOutcome, noOutcome] = await Promise.all([
        this.waitForFillOutcome(yesOrderId, size, remainingFillTimeoutMs),
        this.waitForFillOutcome(noOrderId, size, remainingFillTimeoutMs)
      ]);

      const fillMs = Math.max(yesOutcome.observedAtMs, noOutcome.observedAtMs);
      const yesFull = yesOutcome.fullyFilled;
      const noFull = noOutcome.fullyFilled;

      if (yesFull && noFull) {
        state = this.transition(state, { type: 'FILL_YES', atMs: fillMs });
        state = this.transition(state, { type: 'FILL_NO', atMs: fillMs });

        if (this.metrics) {
          this.metrics.recordFill(opportunity.marketId, nowMs);
          this.metrics.recordFill(opportunity.marketId, nowMs);
          this.metrics.recordLatency({
            stage: 'filled',
            opportunityId: opportunity.id,
            marketId: opportunity.marketId,
            timestampMs: fillMs,
            latencyMs: fillMs - ackStageMs,
            cumulativeMs: fillMs - detectedAt
          });
        }

        state = this.transition(state, { type: 'COMPLETE', atMs: fillMs });

        if (this.metrics) {
          this.metrics.recordLatency({
            stage: 'complete',
            opportunityId: opportunity.id,
            marketId: opportunity.marketId,
            timestampMs: fillMs,
            latencyMs: fillMs - detectedAt,
            cumulativeMs: fillMs - detectedAt
          });
        }

        if (yesOrderId) {
          this.saveIdempotencyRecord({
            ...yesRecord,
            orderId: yesOrderId,
            status: 'confirmed',
            updatedAt: fillMs
          });
        }
        if (noOrderId) {
          this.saveIdempotencyRecord({
            ...noRecord,
            orderId: noOrderId,
            status: 'confirmed',
            updatedAt: fillMs
          });
        }

        return finalize(
          {
            status: 'submitted',
            yesOrder: yesResponse,
            noOrder: noResponse,
            idempotencyKey,
            executionId,
            state: state.state
          },
          fillMs
        );
      }

      const yesMatched = yesOutcome.sizeMatched;
      const noMatched = noOutcome.sizeMatched;

      const filledLeg =
        yesMatched > 0 && noMatched <= 0 ? 'yes' : noMatched > 0 && yesMatched <= 0 ? 'no' : null;
      if (!filledLeg) {
        const timedOut = yesOutcome.timedOut || noOutcome.timedOut;
        return finalize(
          await handleFailure(
            state,
            fillMs,
            timedOut ? 'order_timeout' : 'order_failed',
            timedOut ? 'order_timeout' : 'order_failed',
            { yesOutcome, noOutcome, fillMs },
            yesResponse,
            noResponse
          ),
          fillMs
        );
      }

      const filledSize = Math.min(filledLeg === 'yes' ? yesMatched : noMatched, size);
      const failureReason = yesOutcome.timedOut || noOutcome.timedOut ? 'order_timeout' : 'order_failed';
      return finalize(
        await handlePartialFill(
          state,
          fillMs,
          filledLeg,
          filledSize,
          failureReason,
          { yesOutcome, noOutcome },
          yesResponse,
          noResponse
        ),
        fillMs
      );
    }

    const fillMs = Date.now();
    state = this.transition(state, { type: 'FILL_YES', atMs: fillMs });
    state = this.transition(state, { type: 'FILL_NO', atMs: fillMs });

    if (this.metrics) {
      this.metrics.recordFill(opportunity.marketId, nowMs);
      this.metrics.recordFill(opportunity.marketId, nowMs);
      this.metrics.recordLatency({
        stage: 'filled',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: fillMs,
        latencyMs: fillMs - ackStageMs,
        cumulativeMs: fillMs - detectedAt
      });
    }

    state = this.transition(state, { type: 'COMPLETE', atMs: fillMs });

    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'complete',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: fillMs,
        latencyMs: fillMs - detectedAt,
        cumulativeMs: fillMs - detectedAt
      });
    }

    if (yesOrderId) {
      this.saveIdempotencyRecord({
        ...yesRecord,
        orderId: yesOrderId,
        status: 'confirmed',
        updatedAt: fillMs
      });
    }
    if (noOrderId) {
      this.saveIdempotencyRecord({
        ...noRecord,
        orderId: noOrderId,
        status: 'confirmed',
        updatedAt: fillMs
      });
    }

    return finalize(
      {
        status: 'submitted',
        yesOrder: yesResponse,
        noOrder: noResponse,
        idempotencyKey,
        executionId,
        state: state.state
      },
      fillMs
    );
  }

  private toBasketLegOpportunity(
    basketOpportunity: ArbitrageOpportunity,
    leg: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'][number],
    nowMs: number
  ): ArbitrageOpportunity {
    return {
      id: fwOpportunityId(leg.marketId, leg.projectedEdge, leg.edgeLowerBound, nowMs),
      marketId: leg.marketId,
      yesTokenId: leg.yesTokenId,
      noTokenId: leg.noTokenId,
      yesPrice: leg.yesPrice,
      noPrice: leg.noPrice,
      costPerSet: leg.costPerSet,
      edge: leg.edgeLowerBound,
      tickSize: leg.tickSize,
      maxSizeByDepth: leg.maxSizeByDepth,
      minOrderSize: leg.minOrderSize,
      detectedAt: basketOpportunity.detectedAt,
      gateReasons: [],
      pair: {
        marketId: leg.marketId,
        yesTokenId: leg.yesTokenId,
        noTokenId: leg.noTokenId
      },
      type: 'fw_projection',
      fw: basketOpportunity.fw
    };
  }

  private async trySubmitBasketBatch(
    opportunity: ArbitrageOpportunity,
    size: number,
    nowMs: number,
    basketIdempotencyKey: string
  ): Promise<{
    outcome: 'submitted' | 'partial' | 'fallback';
    legs: BasketExecutionLegState[];
    acceptedOrders: BasketBatchAcceptedOrder[];
  }> {
    const legs = opportunity.fwBasket?.markets ?? [];
    if (legs.length === 0) return { outcome: 'fallback', legs: [], acceptedOrders: [] };

    const payloadOrders: Record<string, unknown>[] = [];
    const orderMetadata: BasketBatchOrderMetadata[] = [];
    const legStates: BasketExecutionLegState[] = [];
    for (const leg of legs) {
      const legIdempotencyKey = `${basketIdempotencyKey}:${leg.marketId}`;
      const yesIdempotencyKey = `${legIdempotencyKey}:yes`;
      const noIdempotencyKey = `${legIdempotencyKey}:no`;
      const yesRecord = this.ensureIdempotencyRecord(yesIdempotencyKey, nowMs);
      const noRecord = this.ensureIdempotencyRecord(noIdempotencyKey, nowMs);
      legStates.push({
        marketId: leg.marketId,
        yesTokenId: leg.yesTokenId,
        noTokenId: leg.noTokenId,
        idempotencyKey: legIdempotencyKey,
        state: 'pending'
      });

      payloadOrders.push(
        {
          ...toClobOrderPayload(
            buildFokBuyOrder({
              tokenId: leg.yesTokenId,
              size,
              price: leg.yesPrice,
              clientOrderId: yesIdempotencyKey
            })
          ),
          nonce: coerceNonceValue(yesRecord.nonce)
        },
        {
          ...toClobOrderPayload(
            buildFokBuyOrder({
              tokenId: leg.noTokenId,
              size,
              price: leg.noPrice,
              clientOrderId: noIdempotencyKey
            })
          ),
          nonce: coerceNonceValue(noRecord.nonce)
        }
      );
      orderMetadata.push(
        { marketId: leg.marketId, side: 'yes', idempotencyKey: yesIdempotencyKey },
        { marketId: leg.marketId, side: 'no', idempotencyKey: noIdempotencyKey }
      );
    }

    try {
      const response = await withTimeout(
        this.clob.createBatchOrders({ orders: payloadOrders }),
        this.timeouts.submitTimeoutMs,
        'batch_submit'
      );
      const parsed = parseBatchOutcome(response, payloadOrders.length);
      const accepted = new Set(parsed.acceptedIndices);
      const acceptedOrders: BasketBatchAcceptedOrder[] = [];
      const acceptedByMarket = new Map<string, Set<'yes' | 'no'>>();
      for (const index of parsed.acceptedIndices) {
        const metadata = orderMetadata[index];
        if (!metadata) continue;
        const record = this.getIdempotencyRecord(metadata.idempotencyKey);
        const payload = parsed.candidateOrders?.[index];
        const order = coerceOrderResponse(payload);
        const orderId = extractOrderId(order) ?? record?.orderId;
        if (record) {
          this.saveIdempotencyRecord({
            ...record,
            orderId,
            status: 'submitted',
            updatedAt: nowMs
          });
        }
        if (orderId) {
          acceptedOrders.push({
            marketId: metadata.marketId,
            side: metadata.side,
            idempotencyKey: metadata.idempotencyKey,
            orderId
          });
        }
        const perMarket = acceptedByMarket.get(metadata.marketId) ?? new Set<'yes' | 'no'>();
        perMarket.add(metadata.side);
        acceptedByMarket.set(metadata.marketId, perMarket);
      }

      for (let index = 0; index < orderMetadata.length; index += 1) {
        if (accepted.has(index)) continue;
        const metadata = orderMetadata[index];
        this.markIdempotencyFailed(metadata.idempotencyKey, nowMs);
      }

      const nextLegStates = legStates.map((leg) => {
        const acceptedSides = acceptedByMarket.get(leg.marketId);
        if (acceptedSides?.has('yes') && acceptedSides?.has('no')) {
          return { ...leg, state: 'acked' as const };
        }
        if (acceptedSides && acceptedSides.size > 0) {
          return { ...leg, state: 'failed' as const, reason: 'batch_partial' };
        }
        return {
          ...leg,
          state: 'failed' as const,
          reason: parsed.outcome === 'fallback' ? 'batch_fallback' : 'batch_partial'
        };
      });

      if (parsed.outcome === 'fallback') {
        this.metrics?.record({
          type: 'fw_basket',
          timestamp: nowMs,
          data: { event: 'batch_fallback', basketId: opportunity.fwBasket?.basketId, legs: legs.length }
        });
      }

      return { outcome: parsed.outcome, legs: nextLegStates, acceptedOrders };
    } catch (error) {
      for (const metadata of orderMetadata) {
        this.markIdempotencyFailed(metadata.idempotencyKey, nowMs);
      }
      this.metrics?.record({
        type: 'fw_basket',
        timestamp: nowMs,
        data: {
          event: 'batch_fallback',
          basketId: opportunity.fwBasket?.basketId,
          legs: legs.length,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return {
        outcome: 'fallback',
        legs: legStates.map((leg) => ({ ...leg, state: 'failed', reason: 'batch_fallback' })),
        acceptedOrders: []
      };
    }
  }

  private async waitForBatchFillOutcomes(
    acceptedOrders: BasketBatchAcceptedOrder[],
    size: number,
    timeoutMs: number
  ): Promise<{
    allFilled: boolean;
    outcomes: Array<{ order: BasketBatchAcceptedOrder; outcome: UserFillOutcome }>;
    observedAtMs: number;
  }> {
    const outcomes = await Promise.all(
      acceptedOrders.map(async (order) => {
        const outcome = await this.waitForFillOutcome(order.orderId, size, timeoutMs);
        return { order, outcome };
      })
    );
    const observedAtMs = outcomes.reduce(
      (max, entry) => Math.max(max, entry.outcome.observedAtMs),
      Date.now()
    );
    return {
      allFilled: outcomes.every((entry) => entry.outcome.fullyFilled),
      outcomes,
      observedAtMs
    };
  }

  private async cancelOutstandingBatchOrders(
    outcomes: Array<{ order: BasketBatchAcceptedOrder; outcome: UserFillOutcome }>,
    opportunityId: string,
    nowMs: number
  ): Promise<void> {
    const outstanding = outcomes.filter((entry) => !entry.outcome.fullyFilled);
    for (const entry of outstanding) {
      try {
        await withTimeout(
          this.clob.cancelOrder(entry.order.orderId),
          this.timeouts.cancelTimeoutMs,
          'batch_cancel'
        );
        this.markIdempotencyFailed(entry.order.idempotencyKey, nowMs);
      } catch (error) {
        this.incidentTracker?.record({
          marketId: entry.order.marketId,
          reason: 'order_cancel_failed',
          timestamp: nowMs,
          opportunityId,
          detail: {
            orderId: entry.order.orderId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  private async unwindBasketLegs(
    basketOpportunity: ArbitrageOpportunity,
    legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
    size: number,
    nowMs: number
  ): Promise<void> {
    for (const leg of legs) {
      const unwindYesPrice = this.calculateUnwindPrice(
        leg.yesPrice,
        leg.tickSize,
        { marketId: leg.marketId, opportunityId: basketOpportunity.id, nowMs }
      );
      const unwindNoPrice = this.calculateUnwindPrice(
        leg.noPrice,
        leg.tickSize,
        { marketId: leg.marketId, opportunityId: basketOpportunity.id, nowMs }
      );
      const yesPayload = toClobOrderPayload(
        buildFakSellOrder({
          tokenId: leg.yesTokenId,
          size,
          price: unwindYesPrice,
          clientOrderId: `${basketOpportunity.id}:${leg.marketId}:yes:basket_unwind`
        })
      );
      const noPayload = toClobOrderPayload(
        buildFakSellOrder({
          tokenId: leg.noTokenId,
          size,
          price: unwindNoPrice,
          clientOrderId: `${basketOpportunity.id}:${leg.marketId}:no:basket_unwind`
        })
      );
      try {
        await Promise.all([
          withTimeout(this.clob.createOrder(yesPayload), this.timeouts.submitTimeoutMs, 'basket_unwind_yes'),
          withTimeout(this.clob.createOrder(noPayload), this.timeouts.submitTimeoutMs, 'basket_unwind_no')
        ]);
      } catch (error) {
        this.incidentTracker?.record({
          marketId: leg.marketId,
          reason: 'unwind_failed',
          timestamp: Date.now(),
          opportunityId: basketOpportunity.id,
          detail: {
            message: error instanceof Error ? error.message : String(error ?? 'unwind_failed')
          }
        });
      }
    }
  }

  private async executeEvOrder(
    opportunity: ArbitrageOpportunity,
    size: number,
    _context: ExecutionContext | undefined,
    params: {
      nowMs: number;
      idempotencyKey: string;
      executionId: string;
      idleState: ExecutionState;
      timeouts: ExecutionTimeouts;
      yesIdempotencyKey: string;
      noIdempotencyKey: string;
      yesRecord: IdempotencyRecord;
      noRecord: IdempotencyRecord;
      trackedOrderIds: string[];
      requiresUserChannel: boolean;
    }
  ): Promise<ExecutionResult> {
    const {
      nowMs,
      idempotencyKey,
      executionId,
      idleState,
      timeouts,
      yesIdempotencyKey,
      noIdempotencyKey,
      yesRecord,
      noRecord,
      trackedOrderIds,
      requiresUserChannel
    } = params;

    const side = opportunity.side;
    if (!side) {
      return {
        status: 'blocked',
        reason: 'ev_missing_side',
        idempotencyKey,
        executionId,
        state: idleState
      };
    }

    const tokenId = side === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;
    const price = side === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
    if (!Number.isFinite(price) || price <= 0) {
      return {
        status: 'blocked',
        reason: 'invalid_price',
        idempotencyKey,
        executionId,
        state: idleState
      };
    }

    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'detected',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: opportunity.detectedAt,
        latencyMs: 0,
        cumulativeMs: 0
      });
    }

    if (this.portfolio) {
      this.portfolio.expectFill({
        opportunityId: opportunity.id,
        tokenId,
        expectedSize: size,
        expectedPrice: price,
        timestamp: nowMs
      });
    }

    const recordKey = side === 'yes' ? yesIdempotencyKey : noIdempotencyKey;
    const record = side === 'yes' ? yesRecord : noRecord;

    const submitMs = Date.now();
    if (this.metrics) {
      this.metrics.recordLatency({
        stage: 'submitted',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: submitMs,
        latencyMs: submitMs - opportunity.detectedAt,
        cumulativeMs: submitMs - opportunity.detectedAt
      });
    }
    this.metrics?.recordOrderAttempt(opportunity.marketId, submitMs);

    const payload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId,
        size,
        price,
        clientOrderId: recordKey
      })
    );
    const payloadWithNonce = {
      ...payload,
      nonce: coerceNonceValue(record.nonce)
    };

    let response: unknown;
    try {
      response = await withTimeout(
        this.clob.createOrder(payloadWithNonce),
        timeouts.submitTimeoutMs,
        `ev_submit_${side}`
      );
    } catch (error) {
      const failureAtMs = Date.now();
      const incidentReason: IncidentReason = isTimeoutError(error) ? 'order_timeout' : 'order_failed';
      const detail = isTimeoutError(error)
        ? { phase: error.phase, timeoutMs: error.timeoutMs }
        : { error: error instanceof Error ? error.message : String(error) };
      this.markIdempotencyFailed(recordKey, failureAtMs);
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: incidentReason,
        timestamp: failureAtMs,
        opportunityId: opportunity.id,
        detail
      });
      return {
        status: 'failed',
        reason: incidentReason,
        idempotencyKey,
        executionId,
        state: 'failed'
      };
    }

    const ackMs = Date.now();
    let order = coerceOrderResponse(response);
    const orderId = extractOrderId(order) ?? record.orderId;
    trackedOrderIds.length = 0;
    if (orderId) trackedOrderIds.push(orderId);
    if (orderId && !extractOrderId(order)) {
      order = { ...order, orderID: orderId };
    }

    this.saveIdempotencyRecord({
      ...record,
      orderId,
      status: orderId ? 'submitted' : record.status,
      updatedAt: ackMs
    });

    if (this.metrics) {
      if (isDelayedOrderResponse(response)) {
        this.metrics.recordDelayedAck(opportunity.marketId, ackMs);
      }
      this.metrics.recordLatency({
        stage: 'acked',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: ackMs,
        latencyMs: ackMs - submitMs,
        cumulativeMs: ackMs - opportunity.detectedAt
      });
    }

    if (isDelayedOrderResponse(response)) {
      this.markIdempotencyFailed(recordKey, ackMs);
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_delayed',
        timestamp: ackMs,
        opportunityId: opportunity.id,
        detail: { order }
      });
      return {
        status: 'failed',
        reason: 'order_delayed',
        yesOrder: side === 'yes' ? order : undefined,
        noOrder: side === 'no' ? order : undefined,
        idempotencyKey,
        executionId,
        state: 'failed'
      };
    }

    if (isOrderFailure(response)) {
      this.markIdempotencyFailed(recordKey, ackMs);
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_rejected',
        timestamp: ackMs,
        opportunityId: opportunity.id,
        detail: { order }
      });
      return {
        status: 'failed',
        reason: 'order_rejected',
        yesOrder: side === 'yes' ? order : undefined,
        noOrder: side === 'no' ? order : undefined,
        idempotencyKey,
        executionId,
        state: 'failed'
      };
    }

    if (!requiresUserChannel) {
      return {
        status: 'submitted',
        yesOrder: side === 'yes' ? order : undefined,
        noOrder: side === 'no' ? order : undefined,
        idempotencyKey,
        executionId,
        state: 'complete'
      };
    }

    if (!orderId) {
      const failureAtMs = Date.now();
      this.markIdempotencyFailed(recordKey, failureAtMs);
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_failed',
        timestamp: failureAtMs,
        opportunityId: opportunity.id,
        detail: { orderId, order }
      });
      return {
        status: 'failed',
        reason: 'order_failed',
        yesOrder: side === 'yes' ? order : undefined,
        noOrder: side === 'no' ? order : undefined,
        idempotencyKey,
        executionId,
        state: 'failed'
      };
    }

    const remainingFillTimeoutMs =
      timeouts.fillTimeoutMs > 0 ? Math.max(0, timeouts.fillTimeoutMs - (Date.now() - ackMs)) : 0;

    const outcome = await this.waitForFillOutcome(orderId, size, remainingFillTimeoutMs);
    const fillMs = Math.max(ackMs, outcome.observedAtMs);

    if (outcome.fullyFilled) {
      if (this.metrics) {
        this.metrics.recordFill(opportunity.marketId, fillMs);
        this.metrics.recordLatency({
          stage: 'filled',
          opportunityId: opportunity.id,
          marketId: opportunity.marketId,
          timestampMs: fillMs,
          latencyMs: fillMs - ackMs,
          cumulativeMs: fillMs - opportunity.detectedAt
        });
        this.metrics.recordLatency({
          stage: 'complete',
          opportunityId: opportunity.id,
          marketId: opportunity.marketId,
          timestampMs: fillMs,
          latencyMs: fillMs - opportunity.detectedAt,
          cumulativeMs: fillMs - opportunity.detectedAt
        });
      }

      this.saveIdempotencyRecord({
        ...record,
        orderId,
        status: 'confirmed',
        updatedAt: fillMs
      });

      return {
        status: 'submitted',
        yesOrder: side === 'yes' ? order : undefined,
        noOrder: side === 'no' ? order : undefined,
        idempotencyKey,
        executionId,
        state: 'complete'
      };
    }

    const failureAtMs = Date.now();
    const failureReason: IncidentReason = outcome.timedOut ? 'order_timeout' : 'order_failed';
    this.markIdempotencyFailed(recordKey, failureAtMs);
    this.incidentTracker?.record({
      marketId: opportunity.marketId,
      reason: failureReason,
      timestamp: failureAtMs,
      opportunityId: opportunity.id,
      detail: { outcome, orderId }
    });

    return {
      status: 'failed',
      reason: failureReason,
      yesOrder: side === 'yes' ? order : undefined,
      noOrder: side === 'no' ? order : undefined,
      idempotencyKey,
      executionId,
      state: outcome.timedOut ? 'timeout' : 'failed'
    };
  }

  private getIdempotencyRecord(key: string): IdempotencyRecord | undefined {
    const cached = this.idempotencyCache.get(key);
    if (cached) return cached;
    const stored = this.store?.getIdempotencyRecord?.(key);
    if (stored) {
      this.idempotencyCache.set(key, stored);
    }
    return stored;
  }

  private saveIdempotencyRecord(record: IdempotencyRecord): void {
    this.idempotencyCache.set(record.key, record);
    this.store?.upsertIdempotencyRecord?.(record);
  }

  private ensureIdempotencyRecord(key: string, nowMs: number): IdempotencyRecord {
    const existing = this.getIdempotencyRecord(key);
    if (existing && existing.status !== 'failed') {
      const refreshed = { ...existing, updatedAt: nowMs };
      this.saveIdempotencyRecord(refreshed);
      return refreshed;
    }

    const record: IdempotencyRecord = {
      key,
      nonce: this.clob.reserveNonce(),
      status: 'pending',
      orderId: undefined,
      createdAt: nowMs,
      updatedAt: nowMs
    };
    this.saveIdempotencyRecord(record);
    return record;
  }

  private markIdempotencyFailed(key: string, nowMs: number): void {
    const existing = this.getIdempotencyRecord(key);
    if (!existing) return;
    this.saveIdempotencyRecord({ ...existing, status: 'failed', updatedAt: nowMs });
  }

  private pruneIdempotencyRecords(beforeMs: number): void {
    this.store?.pruneIdempotencyRecords?.(beforeMs);
    for (const [key, record] of this.idempotencyCache.entries()) {
      if (record.updatedAt < beforeMs) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  private resolveUnwindTickSize(
    leg: 'yes' | 'no',
    opportunity: ArbitrageOpportunity,
    context?: ExecutionContext
  ): number {
    const bookTick =
      leg === 'yes' ? context?.yesBook?.tickSize : context?.noBook?.tickSize;
    if (typeof bookTick === 'number' && bookTick > 0) return bookTick;
    if (opportunity.tickSize > 0) return opportunity.tickSize;
    return this.policy.fallbackTickSize;
  }

  private calculateUnwindPrice(
    entryPrice: number,
    tickSize: number,
    advisory?: { marketId: string; opportunityId: string; nowMs?: number }
  ): number {
    if (tickSize <= 0) return entryPrice;
    const maxLossTicks = Math.max(this.riskConfig.maxUnwindLossTicks, 0);
    const slippageFraction = Math.max(this.riskConfig.unwindSlippageToleranceBps, 0) / 10000;
    const slippageTicks =
      slippageFraction > 0 ? Math.ceil((entryPrice * slippageFraction) / tickSize) : maxLossTicks;
    const baseLossTicks = Math.min(maxLossTicks, slippageTicks);
    const lossTicks = advisory
      ? this.applyUnwindHint(
          advisory.marketId,
          advisory.opportunityId,
          baseLossTicks,
          maxLossTicks,
          advisory.nowMs
        )
      : baseLossTicks;
    const capped = entryPrice - tickSize * lossTicks;
    const bounded = Math.max(capped, tickSize);
    return alignPriceUp(bounded, tickSize);
  }

  private applyUnwindHint(
    marketId: string,
    opportunityId: string,
    baseLossTicks: number,
    maxLossTicks: number,
    nowMs = Date.now()
  ): number {
    const advisor = this.executionAdvisor;
    const mode = this.executionAdvisorMode;
    if (!advisor || mode === 'disabled') return baseLossTicks;

    const hint = advisor.getHint(marketId, nowMs);
    if (!hint) return baseLossTicks;

    const minLossTicks = baseLossTicks === 0 ? 0 : 1;
    let advisedLossTicks = baseLossTicks;

    if (hint.unwindHint === 'aggressive') {
      advisedLossTicks = Math.min(
        maxLossTicks,
        Math.max(baseLossTicks, Math.ceil(baseLossTicks * 1.5))
      );
    } else if (hint.unwindHint === 'conservative') {
      advisedLossTicks = Math.max(minLossTicks, Math.floor(baseLossTicks * 0.75));
    }

    this.metrics?.record({
      type: 'shadow_decision',
      timestamp: nowMs,
      data: {
        agent: 'ExecutionAgent',
        marketId,
        opportunityId,
        decision: 'unwind_loss_ticks',
        hint: { unwindHint: hint.unwindHint, confidence: hint.confidence },
        baseLossTicks,
        advisedLossTicks,
        maxLossTicks
      }
    });

    return mode === 'advisory' ? advisedLossTicks : baseLossTicks;
  }

  private recordUnwindPortfolio(
    marketId: string,
    tokenId: string,
    entryPrice: number,
    unwindPrice: number,
    size: number
  ): void {
    if (!this.portfolio) return;
    this.portfolio.applyUnwind({ marketId, tokenId, entryPrice, unwindPrice, size });
  }

  private emitExecutionOutcome(
    opportunity: ArbitrageOpportunity,
    result: ExecutionResult,
    atMs = Date.now()
  ): void {
    const status =
      result.status === 'failed' && result.reason?.includes('timeout') ? 'timeout' : result.status;
    messageBus.emit('execution:outcome', {
      marketId: opportunity.marketId,
      opportunityId: opportunity.id,
      executionId: result.executionId,
      idempotencyKey: result.idempotencyKey,
      status,
      reason: result.reason,
      at_ms: atMs
    });
  }

  private transition(current: PairedExecutionState, event: ExecutionEvent): PairedExecutionState {
    const next = transitionExecutionState(current, event);
    const action = getRequiredAction(next.state);

    this.activeExecutions.set(next.id, next);
    this.metrics?.record({
      type: 'execution_lifecycle',
      timestamp: event.atMs,
      data: {
        executionId: next.id,
        opportunityId: next.opportunityId,
        marketId: next.marketId,
        state: next.state,
        previousState: current.state,
        eventType: event.type,
        action,
        error: next.error,
        yesSubmitted: next.yesSubmitted,
        noSubmitted: next.noSubmitted,
        yesAcked: next.yesAcked,
        noAcked: next.noAcked,
        yesFilled: next.yesFilled,
        noFilled: next.noFilled
      }
    });

    this.store?.append({
      id: randomUUID(),
      timestamp: event.atMs,
      type: 'execution:transition',
      payload: {
        executionId: next.id,
        opportunityId: next.opportunityId,
        marketId: next.marketId,
        previousState: current.state,
        state: next.state,
        event,
        snapshot: next
      },
      metadata: { agent: 'ExecutionAgent', correlationId: next.id }
    });

    if (action === 'none') {
      this.activeExecutions.delete(next.id);
    }

    return next;
  }
}

function parseBatchOutcome(
  response: unknown,
  expectedOrders: number
): {
  outcome: 'submitted' | 'partial' | 'fallback';
  acceptedIndices: number[];
  candidateOrders?: unknown[];
} {
  const arrayPayload = Array.isArray(response) ? response : null;
  const objectPayload = response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const candidateOrders =
    arrayPayload ??
    (Array.isArray(objectPayload?.orders)
      ? (objectPayload!.orders as unknown[])
      : Array.isArray(objectPayload?.results)
      ? (objectPayload!.results as unknown[])
      : null);
  if (candidateOrders) {
    const acceptedIndices: number[] = [];
    for (let index = 0; index < candidateOrders.length; index += 1) {
      const order = candidateOrders[index];
      if (!isOrderFailure(order) && !isDelayedOrderResponse(order)) {
        acceptedIndices.push(index);
      }
    }
    const accepted = acceptedIndices.length;
    if (accepted >= expectedOrders && expectedOrders > 0) {
      return { outcome: 'submitted', acceptedIndices, candidateOrders };
    }
    if (accepted > 0) {
      return { outcome: 'partial', acceptedIndices, candidateOrders };
    }
    return { outcome: 'fallback', acceptedIndices: [], candidateOrders };
  }

  const acceptedCountRaw = objectPayload?.acceptedCount ?? objectPayload?.accepted;
  const acceptedCount =
    typeof acceptedCountRaw === 'number' && Number.isFinite(acceptedCountRaw) ? acceptedCountRaw : undefined;
  if (acceptedCount !== undefined) {
    const bounded = Math.max(0, Math.min(expectedOrders, Math.floor(acceptedCount)));
    const acceptedIndices = Array.from({ length: bounded }, (_unused, index) => index);
    if (acceptedCount >= expectedOrders && expectedOrders > 0) {
      return { outcome: 'submitted', acceptedIndices };
    }
    if (acceptedCount > 0) {
      return { outcome: 'partial', acceptedIndices };
    }
    return { outcome: 'fallback', acceptedIndices: [] };
  }

  const success = objectPayload?.success;
  if (success === true) return { outcome: 'partial', acceptedIndices: [] };
  return { outcome: 'fallback', acceptedIndices: [] };
}

function applyMultiplier(timeoutMs: number, multiplier: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return timeoutMs;
  const scaled = Math.floor(timeoutMs * multiplier);
  return Math.min(timeoutMs, Math.max(scaled, 1));
}

class TimeoutError extends Error {
  constructor(
    public readonly phase: string,
    public readonly timeoutMs: number
  ) {
    super(`timeout:${phase}`);
    this.name = 'TimeoutError';
  }
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer!: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(phase, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function coerceNonceValue(nonce: string): string | number {
  const numeric = Number(nonce);
  return Number.isFinite(numeric) ? numeric : nonce;
}

function alignPriceUp(price: number, tickSize: number): number {
  return Math.ceil(price / tickSize) * tickSize;
}

function isOrderSuccessful(order?: OrderResponse): boolean {
  if (!order) return false;
  if (isOrderFailure(order)) return false;
  if (isDelayedOrderResponse(order)) return false;
  return true;
}

function extractOrderId(order?: OrderResponse): string | undefined {
  if (!order) return undefined;
  const payload = order as OrderResponse & { orderId?: string; order_id?: string };
  return payload.orderID ?? payload.orderId ?? payload.order_id;
}

function isCancelFailure(
  response: CancelOrdersResponse | null | undefined,
  expectedId?: string
): boolean {
  if (!response) return true;
  const canceled = Array.isArray(response.canceled) ? response.canceled : [];
  const notCanceled =
    response.not_canceled && typeof response.not_canceled === 'object'
      ? response.not_canceled
      : undefined;
  const hasNotCanceled = !!notCanceled && Object.keys(notCanceled).length > 0;
  if (expectedId) {
    return hasNotCanceled || !canceled.includes(expectedId);
  }
  return hasNotCanceled;
}

function formatCancelError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'cancel_failed');
}

function isCancellationOrderUpdate(update: UserOrderUpdate): boolean {
  const eventType = update.orderEventType?.toUpperCase();
  if (eventType === 'CANCELLATION') return true;

  const status = update.status?.toUpperCase();
  if (!status) return false;
  return status === 'CANCELLED' || status === 'CANCELED' || status === 'CANCEL';
}

function isFilledOrderStatus(status: string | undefined): boolean {
  if (!status) return false;
  const normalized = status.toUpperCase();
  return normalized === 'MATCHED' || normalized === 'FILLED' || normalized === 'CONFIRMED' || normalized === 'MINED';
}

function normalizeOrderSide(side: string | undefined): 'BUY' | 'SELL' | undefined {
  if (!side) return undefined;
  const normalized = side.toUpperCase();
  if (normalized === 'BUY') return 'BUY';
  if (normalized === 'SELL') return 'SELL';
  return undefined;
}
