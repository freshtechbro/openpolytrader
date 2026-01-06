import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import { isNearZeroRiskMode } from '../../config/policy.js';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../../config/risk.js';
import type { TradingMode } from '../../config/env.js';
import type { EventStore, StoredEvent } from '../../core/EventStore.js';
import type { CircuitBreakerRegistry } from '../../core/CircuitBreaker.js';
import {
  buildFakSellOrder,
  buildFokBuyOrder,
  coerceOrderResponse,
  createInitialExecutionState,
  getRequiredAction,
  isDelayedOrderResponse,
  isOrderFailure,
  toClobOrderPayload,
  transitionExecutionState,
  type ExecutionEvent,
  type ExecutionState,
  type PairedExecutionState,
  type UnwindResult
} from '../../domain/execution.js';
import type { IncidentReason } from '../../domain/incident.js';
import { createIdempotencyKey, type IdempotencyRecord } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { OrderResponse } from '../../domain/types.js';
import { PolymarketClob, type CancelOrdersResponse } from '../../services/PolymarketClob.js';
import type { PolymarketRealtime, UserOrderUpdate, UserTradeUpdate } from '../../services/PolymarketRealtime.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';

export interface ExecutionResult {
  status: 'submitted' | 'failed' | 'blocked';
  reason?: string;
  yesOrder?: OrderResponse;
  noOrder?: OrderResponse;
  idempotencyKey: string;
  executionId: string;
  state: ExecutionState;
}

export interface ExecutionAgentConfig {
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  eventStore?: EventStore;
  riskConfig?: RiskConfig;
  portfolio?: PortfolioAgent;
  userRealtime?: PolymarketRealtime;
  circuitBreakers?: CircuitBreakerRegistry;
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

export class ExecutionAgent {
  private tradingEnabled: boolean;
  private tradingMode: TradingMode;
  private store?: EventStore;
  private riskConfig: RiskConfig;
  private portfolio?: PortfolioAgent;
  private userRealtime?: PolymarketRealtime;
  private circuitBreakers?: CircuitBreakerRegistry;
  private timeouts: ExecutionTimeouts;
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

  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    const nowMs = context?.nowMs ?? Date.now();
    const idempotencyKey = createIdempotencyKey(
      `${opportunity.marketId}:${opportunity.yesTokenId}:${opportunity.noTokenId}:${opportunity.detectedAt}`
    );
    const executionId = idempotencyKey;
    const idleState: ExecutionState = 'idle';

    if (this.circuitBreakers?.isOpen(opportunity.marketId)) {
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'circuit_breaker',
        timestamp: nowMs,
        opportunityId: opportunity.id,
        detail: { message: 'market circuit breaker open' }
      });
      return { status: 'blocked', reason: 'circuit_breaker', idempotencyKey, executionId, state: idleState };
    }
    const timeouts = this.timeouts;
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
      const unwindPrice = this.calculateUnwindPrice(entryPrice, tickSize);
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
      return {
        status: 'blocked',
        reason: 'trading_disabled',
        idempotencyKey,
        executionId,
        state: idleState
      };
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
      return {
        status: 'blocked',
        reason,
        idempotencyKey,
        executionId,
        state: idleState
      };
    }

    const requiresUserChannel = isNearZeroRiskMode(this.policy);
    if (requiresUserChannel) {
      if (!this.userRealtime) {
        return { status: 'blocked', reason: 'user_channel_unconfigured', idempotencyKey, executionId, state: idleState };
      }
      if (!this.userRealtime.isConnected()) {
        return { status: 'blocked', reason: 'user_channel_disconnected', idempotencyKey, executionId, state: idleState };
      }
    }

    if (this.policy.rejectDelayed === false) {
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
      return { status: 'blocked', reason: 'decision_latency_exceeded', idempotencyKey, executionId, state: idleState };
    }
    const plannedOrders = 2;

    if (this.metrics) {
      const windowMs = this.policy.orderVelocityWindowMs;
      const velocity = this.metrics.getOrderVelocity(windowMs, nowMs);
      const velocityLimit = this.policy.maxOrdersPerMinute * (windowMs / 60000);
      if (velocity + plannedOrders > velocityLimit) {
        this.incidentTracker?.record({
          marketId: opportunity.marketId,
          reason: 'velocity_throttle',
          timestamp: nowMs,
          opportunityId: opportunity.id,
          detail: { velocity, windowMs, velocityLimit }
        });
        return { status: 'blocked', reason: 'velocity_throttle', idempotencyKey, executionId, state: idleState };
      }

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
        return { status: 'blocked', reason: 'otr_exceeded', idempotencyKey, executionId, state: idleState };
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
          return { status: 'blocked', reason: 'delayed_ack_rate_exceeded', idempotencyKey, executionId, state: idleState };
        }
      }
    }

    if (context?.yesBook?.bestAsk && context?.noBook?.bestAsk) {
      const bandFraction = this.policy.priceBandBps / 10000;
      const yesDeviation =
        opportunity.yesPrice > 0
          ? Math.abs(context.yesBook.bestAsk.price - opportunity.yesPrice) / opportunity.yesPrice
          : 0;
      const noDeviation =
        opportunity.noPrice > 0
          ? Math.abs(context.noBook.bestAsk.price - opportunity.noPrice) / opportunity.noPrice
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
            yesObserved: context.yesBook.bestAsk.price,
            noObserved: context.noBook.bestAsk.price,
            yesExpected: opportunity.yesPrice,
            noExpected: opportunity.noPrice
          }
        });
        return { status: 'blocked', reason: 'price_moved', idempotencyKey, executionId, state: idleState };
      }
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
      return handleFailure(
        state,
        Date.now(),
        resultReason,
        incidentReason,
        detail,
        yesResponse,
        noResponse
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
      return handleFailure(
        state,
        ackStageMs,
        'order_timeout',
        'order_timeout',
        { phase: 'ack', ackLatencyMs, ackTimeoutMs: timeouts.ackTimeoutMs },
        yesResponse,
        noResponse
      );
    }

    if (isDelayedOrderResponse(yesOrder) || isDelayedOrderResponse(noOrder)) {
      return handleFailure(
        state,
        ackStageMs,
        'order_delayed',
        'order_delayed',
        { yesOrder, noOrder },
        yesResponse,
        noResponse
      );
    }

    if (isOrderFailure(yesOrder) || isOrderFailure(noOrder)) {
      return handleFailure(
        state,
        ackStageMs,
        'order_rejected',
        'order_rejected',
        { yesOrder, noOrder },
        yesResponse,
        noResponse
      );
    }

    const legSkewMs = Math.abs(yesAckMs - noAckMs);
    if (this.policy.maxLegSkewMs > 0 && legSkewMs > this.policy.maxLegSkewMs) {
      return handleFailure(
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
      );
    }

    const remainingFillTimeoutMs =
      timeouts.fillTimeoutMs > 0 ? Math.max(0, timeouts.fillTimeoutMs - (Date.now() - ackStageMs)) : 0;

    if (requiresUserChannel && remainingFillTimeoutMs > 0) {
      if (!yesOrderId || !noOrderId) {
        return handleFailure(
          state,
          Date.now(),
          'order_failed',
          'order_failed',
          { yesOrderId, noOrderId },
          yesResponse,
          noResponse
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

        return {
          status: 'submitted',
          yesOrder: yesResponse,
          noOrder: noResponse,
          idempotencyKey,
          executionId,
          state: state.state
        };
      }

      const yesMatched = yesOutcome.sizeMatched;
      const noMatched = noOutcome.sizeMatched;

      const filledLeg =
        yesMatched > 0 && noMatched <= 0 ? 'yes' : noMatched > 0 && yesMatched <= 0 ? 'no' : null;
      if (!filledLeg) {
        const timedOut = yesOutcome.timedOut || noOutcome.timedOut;
        return handleFailure(
          state,
          fillMs,
          timedOut ? 'order_timeout' : 'order_failed',
          timedOut ? 'order_timeout' : 'order_failed',
          { yesOutcome, noOutcome, fillMs },
          yesResponse,
          noResponse
        );
      }

      const filledSize = Math.min(filledLeg === 'yes' ? yesMatched : noMatched, size);
      const failureReason = yesOutcome.timedOut || noOutcome.timedOut ? 'order_timeout' : 'order_failed';
      return handlePartialFill(
        state,
        fillMs,
        filledLeg,
        filledSize,
        failureReason,
        { yesOutcome, noOutcome },
        yesResponse,
        noResponse
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

    return {
      status: 'submitted',
      yesOrder: yesResponse,
      noOrder: noResponse,
      idempotencyKey,
      executionId,
      state: state.state
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

  private calculateUnwindPrice(entryPrice: number, tickSize: number): number {
    if (tickSize <= 0) return entryPrice;
    const maxLossTicks = Math.max(this.riskConfig.maxUnwindLossTicks, 0);
    const slippageFraction = Math.max(this.riskConfig.unwindSlippageToleranceBps, 0) / 10000;
    const slippageTicks =
      slippageFraction > 0 ? Math.ceil((entryPrice * slippageFraction) / tickSize) : maxLossTicks;
    const lossTicks = Math.min(maxLossTicks, slippageTicks);
    const capped = entryPrice - tickSize * lossTicks;
    const bounded = Math.max(capped, tickSize);
    return alignPriceUp(bounded, tickSize);
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
