import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import type { RiskConfig } from '../../config/risk.js';
import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import {
  buildFakSellOrder,
  getRequiredAction,
  transitionExecutionState,
  toClobOrderPayload
} from '../../domain/execution.js';
import type { IdempotencyRecord } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { PolymarketClob } from '../../services/PolymarketClob.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type { ExecutionAdvisor } from './ExecutionAdvisor.js';
import type {
  ExecutionAttemptResult,
  ExecutionAcceptedOrder,
  ExecutionBatchFillObservation
} from './ExecutionContracts.js';
import type { UserFillOutcome } from './ExecutionOrderTracker.js';
import { alignPriceUp, withTimeout } from './ExecutionShared.js';

type PairedExecutionState = Parameters<typeof transitionExecutionState>[0];
type ExecutionEvent = Parameters<typeof transitionExecutionState>[1];

export class ExecutionIdempotencyStore {
  private readonly cache = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly deps: {
      clob: Pick<PolymarketClob, 'reserveNonce'>;
      store?: EventStore;
    }
  ) {}

  getRecord(key: string): IdempotencyRecord | undefined {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const stored = this.deps.store?.getIdempotencyRecord?.(key);
    if (stored) this.cache.set(key, stored);
    return stored;
  }

  saveRecord(record: IdempotencyRecord): void {
    this.cache.set(record.key, record);
    this.deps.store?.upsertIdempotencyRecord?.(record);
  }

  ensureRecord(key: string, nowMs: number): IdempotencyRecord {
    const existing = this.getRecord(key);
    if (existing && existing.status !== 'failed') {
      const refreshed = { ...existing, updatedAt: nowMs };
      this.saveRecord(refreshed);
      return refreshed;
    }

    const record: IdempotencyRecord = {
      key,
      nonce: this.deps.clob.reserveNonce(),
      status: 'pending',
      orderId: undefined,
      createdAt: nowMs,
      updatedAt: nowMs
    };
    this.saveRecord(record);
    return record;
  }

  markFailed(key: string, nowMs: number): void {
    const existing = this.getRecord(key);
    if (!existing) return;
    this.saveRecord({ ...existing, status: 'failed', updatedAt: nowMs });
  }

  prune(beforeMs: number): void {
    this.deps.store?.pruneIdempotencyRecords?.(beforeMs);
    for (const [key, record] of this.cache.entries()) {
      if (record.updatedAt < beforeMs) this.cache.delete(key);
    }
  }
}

export class ExecutionLifecycle {
  constructor(
    private readonly deps: {
      messageBus: MessageBus<RuntimeEventMap>;
      store?: EventStore;
      metrics?: MetricsStore;
      activeExecutions: Map<string, PairedExecutionState>;
    }
  ) {}

  emitExecutionOutcome(
    opportunity: ArbitrageOpportunity,
    result: ExecutionAttemptResult,
    atMs = Date.now()
  ): void {
    const status =
      result.status === 'failed' && result.reason?.includes('timeout') ? 'timeout' : result.status;
    this.deps.messageBus.emit('execution:outcome', {
      marketId: opportunity.marketId,
      opportunityId: opportunity.id,
      executionId: result.executionId,
      idempotencyKey: result.idempotencyKey,
      status,
      reason: result.reason,
      at_ms: atMs
    });
  }

  transition(current: PairedExecutionState, event: ExecutionEvent): PairedExecutionState {
    const next = transitionExecutionState(current, event);
    const action = getRequiredAction(next.state);

    this.deps.activeExecutions.set(next.id, next);
    this.deps.metrics?.record({
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

    this.deps.store?.append({
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

    if (action === 'none') this.deps.activeExecutions.delete(next.id);
    return next;
  }
}

export class ExecutionUnwindSupport {
  constructor(
    private readonly deps: {
      getPolicy(): TradePolicy;
      getRiskConfig(): RiskConfig;
      getExecutionAdvisor(): ExecutionAdvisor | undefined;
      getExecutionAdvisorMode(): 'disabled' | 'shadow' | 'advisory';
      clob: PolymarketClob;
      incidentTracker?: IncidentTracker;
      metrics?: MetricsStore;
      portfolio?: PortfolioAgent;
    }
  ) {}

  resolveUnwindTickSize(
    leg: 'yes' | 'no',
    opportunity: ArbitrageOpportunity,
    context?: { yesBook?: OrderBookState; noBook?: OrderBookState }
  ): number {
    const bookTick = leg === 'yes' ? context?.yesBook?.tickSize : context?.noBook?.tickSize;
    if (typeof bookTick === 'number' && bookTick > 0) return bookTick;
    if (opportunity.tickSize > 0) return opportunity.tickSize;
    return this.deps.getPolicy().fallbackTickSize;
  }

  calculateUnwindPrice(
    entryPrice: number,
    tickSize: number,
    advisory?: { marketId: string; opportunityId: string; nowMs?: number }
  ): number {
    if (tickSize <= 0) return entryPrice;
    const riskConfig = this.deps.getRiskConfig();
    const maxLossTicks = Math.max(riskConfig.maxUnwindLossTicks, 0);
    const slippageFraction = Math.max(riskConfig.unwindSlippageToleranceBps, 0) / 10000;
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

  applyUnwindHint(
    marketId: string,
    opportunityId: string,
    baseLossTicks: number,
    maxLossTicks: number,
    nowMs = Date.now()
  ): number {
    const advisor = this.deps.getExecutionAdvisor();
    const mode = this.deps.getExecutionAdvisorMode();
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

    this.deps.metrics?.record({
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

  recordUnwindPortfolio(
    marketId: string,
    tokenId: string,
    entryPrice: number,
    unwindPrice: number,
    size: number
  ): void {
    this.deps.portfolio?.applyUnwind({ marketId, tokenId, entryPrice, unwindPrice, size });
  }

  async unwindBasketLegs(
    basketOpportunity: ArbitrageOpportunity,
    legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
    size: number,
    nowMs: number,
    submitTimeoutMs: number
  ): Promise<void> {
    for (const leg of legs) {
      const unwindYesPrice = this.calculateUnwindPrice(leg.yesPrice, leg.tickSize, {
        marketId: leg.marketId,
        opportunityId: basketOpportunity.id,
        nowMs
      });
      const unwindNoPrice = this.calculateUnwindPrice(leg.noPrice, leg.tickSize, {
        marketId: leg.marketId,
        opportunityId: basketOpportunity.id,
        nowMs
      });
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
          withTimeout(this.deps.clob.createOrder(yesPayload), submitTimeoutMs, 'basket_unwind_yes'),
          withTimeout(this.deps.clob.createOrder(noPayload), submitTimeoutMs, 'basket_unwind_no')
        ]);
      } catch (error) {
        this.deps.incidentTracker?.record({
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
}

export async function waitForBatchFillOutcomes(
  acceptedOrders: ExecutionAcceptedOrder[],
  size: number,
  timeoutMs: number,
  waitForFillOutcome: (orderId: string, desiredSize: number, timeoutMs: number) => Promise<UserFillOutcome>
): Promise<ExecutionBatchFillObservation> {
  const outcomes = await Promise.all(
    acceptedOrders.map(async (order) => ({
      order,
      outcome: await waitForFillOutcome(order.orderId, size, timeoutMs)
    }))
  );
  const observedAtMs = outcomes.reduce((max, entry) => Math.max(max, entry.outcome.observedAtMs), Date.now());
  return {
    allFilled: outcomes.every((entry) => entry.outcome.fullyFilled),
    outcomes,
    observedAtMs
  };
}

export async function cancelOutstandingBatchOrders(
  outcomes: ExecutionBatchFillObservation['outcomes'],
  opportunityId: string,
  nowMs: number,
  deps: {
    clob: PolymarketClob;
    incidentTracker?: IncidentTracker;
    cancelTimeoutMs: number;
    markIdempotencyFailed(key: string, nowMs: number): void;
  }
): Promise<void> {
  for (const entry of outcomes.filter((candidate) => !candidate.outcome.fullyFilled)) {
    try {
      await withTimeout(deps.clob.cancelOrder(entry.order.orderId), deps.cancelTimeoutMs, 'batch_cancel');
      deps.markIdempotencyFailed(entry.order.idempotencyKey, nowMs);
    } catch (error) {
      deps.incidentTracker?.record({
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
