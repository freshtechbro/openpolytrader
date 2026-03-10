import type { TradePolicy } from '../../config/policy.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type { UserOrderUpdate, UserTradeUpdate } from '../../services/PolymarketRealtime.js';

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

export interface UserFillOutcome {
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

interface ExecutionOrderTrackerDeps {
  messageBus: MessageBus<RuntimeEventMap>;
  portfolio?: PortfolioAgent;
  entrySlippageToleranceBps: number;
}

export class ExecutionOrderTracker {
  readonly userOrders = new Map<string, ObservedUserOrderState>();
  readonly fillWaiters = new Map<string, FillWaiter[]>();
  readonly seenTradesByOrder = new Map<string, Set<string>>();

  constructor(private readonly deps: ExecutionOrderTrackerDeps) {}

  updatePolicy(policy: Pick<TradePolicy, 'entrySlippageToleranceBps'>): void {
    this.deps.entrySlippageToleranceBps = policy.entrySlippageToleranceBps;
  }

  handleUserOrderUpdate(update: UserOrderUpdate): void {
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

  handleUserTradeUpdate(update: UserTradeUpdate): void {
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

  waitForFillOutcome(orderId: string, desiredSize: number, timeoutMs: number): Promise<UserFillOutcome> {
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

  cleanupOrderTracking(orderIds: string[]): void {
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

  private recordPortfolioFillFromTrade(
    orderId: string,
    orderState: ObservedUserOrderState,
    trade: UserTradeUpdate,
    matchedAmount: number
  ): void {
    if (!this.deps.portfolio) return;

    const tokenId = orderState.tokenId ?? trade.assetId;
    const marketId = orderState.marketId ?? trade.marketId;
    const side = orderState.side ?? normalizeOrderSide(trade.side);
    const price = typeof trade.price === 'number' ? trade.price : orderState.price;

    if (!tokenId || !marketId || !side) return;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    if (matchedAmount <= 0 || !Number.isFinite(matchedAmount)) return;

    const timestamp = typeof trade.timestampMs === 'number' ? trade.timestampMs : Date.now();
    const priceTolerance = Math.max(this.deps.entrySlippageToleranceBps, 0) / 10000;

    this.deps.portfolio.applyFillWithReconciliation(
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

    this.deps.messageBus.emit('execution:fill', {
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

  private deriveFillOutcome(orderId: string, desiredSize: number): UserFillOutcome | null {
    const state = this.userOrders.get(orderId);
    if (!state) return null;

    const observedAtMs = state.lastUpdateMs;
    const fullyFilled = state.sizeMatched >= desiredSize || isFilledOrderStatus(state.status);

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
