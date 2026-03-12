import {
  buildFokBuyOrder,
  coerceOrderResponse,
  createInitialBasketExecutionState,
  toClobOrderPayload,
  transitionBasketExecutionState,
  type BasketExecutionLegState
} from '../../domain/execution.js';
import type { TradingMode } from '../../config/env.js';
import { createIdempotencyKey } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderResponse } from '../../domain/types.js';
import type { PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type {
  ExecutionBasketAttemptResult,
  ExecutionContext,
  ExecutionFillServices,
  ExecutionIdempotencyServices,
  ExecutionUnwindServices,
  PairedExecutionService
} from './ExecutionContracts.js';
import { createBasketLegOpportunity, parseBatchOutcome } from './ExecutionBasketUtils.js';

type ExecutionBasketContext = Pick<ExecutionContext, 'nowMs'>;
interface ExecutionBasketTimeouts { submitTimeoutMs: number; fillTimeoutMs: number; cancelTimeoutMs: number; }
interface BasketBatchOrderMetadata { marketId: string; side: 'yes' | 'no'; idempotencyKey: string; }
type BasketBatchAcceptedOrder = Array<Parameters<ExecutionFillServices['waitForBatchFillOutcomes']>[0][number]>[number];

interface ExecutionBasketDeps {
  defaultExecutionMode: 'batch_best_effort' | 'sequential_failfast';
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  clob: PolymarketClob;
  incidentTracker?: IncidentTracker;
  metrics?: MetricsStore;
  userRealtime?: PolymarketRealtime;
  timeouts: ExecutionBasketTimeouts;
  idempotency: ExecutionIdempotencyServices;
  fills: ExecutionFillServices;
  unwind: ExecutionUnwindServices;
  paired: PairedExecutionService;
  withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T>;
  coerceNonceValue(nonce: string): string | number;
  extractOrderId(order?: OrderResponse): string | undefined;
}

export class ExecutionBasketRunner {
  constructor(private readonly deps: ExecutionBasketDeps) {}

  async executeBasketArbitrage(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionBasketContext
  ): Promise<ExecutionBasketAttemptResult> {
    const { idempotency, fills, paired, unwind } = this.deps;
    const nowMs = context?.nowMs ?? Date.now();
    const idempotencyKey = createIdempotencyKey(`${opportunity.id}:basket:${size.toFixed(8)}`);
    const executionId = `${idempotencyKey}:basket`;
    type BasketResult = Awaited<ReturnType<ExecutionBasketRunner['executeBasketArbitrage']>>;

    if (opportunity.type !== 'fw_basket' || !opportunity.fwBasket || opportunity.fwBasket.markets.length === 0) {
      return {
        kind: 'basket',
        status: 'blocked',
        reason: 'fw_basket_missing',
        idempotencyKey,
        executionId,
        state: 'idle'
      };
    }

    const nonLiveReason = getNonLiveBasketReason(this.deps.tradingEnabled, this.deps.tradingMode);
    if (nonLiveReason) {
      return {
        kind: 'basket',
        status: 'blocked',
        reason: nonLiveReason,
        idempotencyKey,
        executionId,
        state: 'idle'
      };
    }

    const mode = opportunity.fwBasket.executionMode ?? this.deps.defaultExecutionMode;
    const legs = opportunity.fwBasket.markets;
    idempotency.ensureRecord(idempotencyKey, nowMs);
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
    ): BasketResult => {
      idempotency.markFailed(idempotencyKey, atMs);
      applyBasketEvent({ type: 'FAILED', atMs, reason });
      this.deps.metrics?.record({
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
        kind: 'basket',
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
    ): BasketResult => {
      const record = idempotency.getRecord(idempotencyKey);
      if (record) {
        idempotency.saveRecord({
          ...record,
          status: 'confirmed',
          updatedAt: atMs
        });
      }
      applyBasketEvent({ type: 'COMPLETE', atMs });
      this.deps.metrics?.record({
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
        kind: 'basket',
        status: 'submitted',
        idempotencyKey,
        executionId,
        state: 'complete',
        basket: { mode: finalMode, fallbackUsed, legs: basketState.legs }
      };
    };

    if (mode === 'batch_best_effort') {
      const batch = await this.trySubmitBasketBatch(opportunity, legs, size, nowMs, idempotencyKey);
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
        if (this.deps.userRealtime?.isConnected() && this.deps.timeouts.fillTimeoutMs > 0 && batch.acceptedOrders.length > 0) {
          const wait = await fills.waitForBatchFillOutcomes(
            batch.acceptedOrders,
            size,
            this.deps.timeouts.fillTimeoutMs
          );
          if (!wait.allFilled) {
            applyBasketEvent({ type: 'PARTIAL_FILL', atMs: wait.observedAtMs, reason: 'partial_fill' });
            await fills.cancelOutstandingBatchOrders(wait.outcomes, opportunity.id, wait.observedAtMs);

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
              await unwind.unwindBasketLegs(opportunity, filledLegs, size, wait.observedAtMs);
            }
            return finalizeBasketFailure('partial_fill', wait.observedAtMs, mode, false);
          }

          for (const accepted of batch.acceptedOrders) {
            applyBasketEvent({ type: 'LEG_FILLED', atMs: wait.observedAtMs, marketId: accepted.marketId });
            const existing = idempotency.getRecord(accepted.idempotencyKey);
            if (existing) {
              idempotency.saveRecord({
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
      const legOpportunity = createBasketLegOpportunity(opportunity, leg, nowMs);
      const legResult = await paired.execute(legOpportunity, size, { nowMs });
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
        await unwind.unwindBasketLegs(opportunity, successfulLegs, size, nowMs);
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

  private async trySubmitBasketBatch(
    opportunity: ArbitrageOpportunity,
    legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
    size: number,
    nowMs: number,
    basketIdempotencyKey: string
  ): Promise<{
    outcome: 'submitted' | 'partial' | 'fallback';
    legs: BasketExecutionLegState[];
    acceptedOrders: BasketBatchAcceptedOrder[];
  }> {
    const { idempotency } = this.deps;

    const payloadOrders: Record<string, unknown>[] = [];
    const orderMetadata: BasketBatchOrderMetadata[] = [];
    const legStates: BasketExecutionLegState[] = [];
    for (const leg of legs) {
      const legIdempotencyKey = `${basketIdempotencyKey}:${leg.marketId}`;
      const yesIdempotencyKey = `${legIdempotencyKey}:yes`;
      const noIdempotencyKey = `${legIdempotencyKey}:no`;
      const yesRecord = idempotency.ensureRecord(yesIdempotencyKey, nowMs);
      const noRecord = idempotency.ensureRecord(noIdempotencyKey, nowMs);
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
          nonce: this.deps.coerceNonceValue(yesRecord.nonce)
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
          nonce: this.deps.coerceNonceValue(noRecord.nonce)
        }
      );
      orderMetadata.push(
        { marketId: leg.marketId, side: 'yes', idempotencyKey: yesIdempotencyKey },
        { marketId: leg.marketId, side: 'no', idempotencyKey: noIdempotencyKey }
      );
    }

    try {
      const response = await this.deps.withTimeout(
        this.deps.clob.createBatchOrders({ orders: payloadOrders }),
        this.deps.timeouts.submitTimeoutMs,
        'batch_submit'
      );
      const parsed = parseBatchOutcome(response, payloadOrders.length);
      const accepted = new Set(parsed.acceptedIndices);
      const acceptedOrders: BasketBatchAcceptedOrder[] = [];
      const acceptedByMarket = new Map<string, Set<'yes' | 'no'>>();
      for (const index of parsed.acceptedIndices) {
        const metadata = orderMetadata[index];
        if (!metadata) continue;
        const record = idempotency.getRecord(metadata.idempotencyKey);
        const payload = parsed.candidateOrders?.[index];
        const order = coerceOrderResponse(payload);
        const orderId = this.deps.extractOrderId(order) ?? record?.orderId;
        if (record) {
          idempotency.saveRecord({
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
        idempotency.markFailed(metadata.idempotencyKey, nowMs);
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
        this.deps.metrics?.record({
          type: 'fw_basket',
          timestamp: nowMs,
          data: { event: 'batch_fallback', basketId: opportunity.fwBasket?.basketId, legs: legs.length }
        });
      }

      return { outcome: parsed.outcome, legs: nextLegStates, acceptedOrders };
    } catch (error) {
      for (const metadata of orderMetadata) {
        idempotency.markFailed(metadata.idempotencyKey, nowMs);
      }
      this.deps.metrics?.record({
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

}

function getNonLiveBasketReason(tradingEnabled: boolean, tradingMode: TradingMode): string | null {
  if (!tradingEnabled) {
    return 'trading_disabled';
  }
  if (tradingMode === 'live') {
    return null;
  }
  if (tradingMode === 'shadow') {
    return 'shadow_mode';
  }
  if (tradingMode === 'paper') {
    return 'paper_mode';
  }
  return 'trading_mode_off';
}
