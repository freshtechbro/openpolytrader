import { isNearZeroRiskMode, type TradePolicy } from '../../config/policy.js';
import type { TradingMode } from '../../config/env.js';
import type { ExecutionState } from '../../domain/execution.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type {
  ExecutionPreflightDecision,
  ExecutionPreflightEffect,
  ExecutionPreflightMetrics,
  ExecutionUserChannel
} from './ExecutionContracts.js';

interface ExecutionPreflightContext {
  nowMs: number;
  opportunity: ArbitrageOpportunity;
  policy: TradePolicy;
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  userRealtime?: ExecutionUserChannel;
  metrics?: ExecutionPreflightMetrics;
  idempotencyKey: string;
  executionId: string;
  idleState: ExecutionState;
  isEv: boolean;
  yesBook?: OrderBookState;
  noBook?: OrderBookState;
}

export function runExecutionPreflight(context: ExecutionPreflightContext): ExecutionPreflightDecision {
  const {
    nowMs,
    opportunity,
    policy,
    tradingEnabled,
    tradingMode,
    userRealtime,
    metrics,
    idempotencyKey,
    executionId,
    idleState,
    isEv,
    yesBook,
    noBook
  } = context;

  const plannedOrders = isEv ? 1 : 2;
  const requiresUserChannel = isNearZeroRiskMode(policy) || isEv;

  if (!tradingEnabled) {
    return blockedDecision(
      false,
      plannedOrders,
      'trading_disabled',
      idempotencyKey,
      executionId,
      idleState
    );
  }

  if (tradingMode !== 'live') {
    const reason =
      tradingMode === 'shadow'
        ? 'shadow_mode'
        : tradingMode === 'paper'
          ? 'paper_mode'
          : 'trading_mode_off';
    return blockedDecision(
      false,
      plannedOrders,
      reason,
      idempotencyKey,
      executionId,
      idleState,
      tradingMode === 'shadow'
        ? [
            {
              type: 'metric',
              event: {
                type: 'shadow_decision',
                timestamp: nowMs,
                data: {
                  marketId: opportunity.marketId,
                  opportunityId: opportunity.id,
                  reason
                }
              }
            }
          ]
        : []
    );
  }

  if (requiresUserChannel) {
    if (!userRealtime) {
      return blockedDecision(
        requiresUserChannel,
        plannedOrders,
        'user_channel_unconfigured',
        idempotencyKey,
        executionId,
        idleState
      );
    }
    if (!userRealtime.isConnected()) {
      return blockedDecision(
        requiresUserChannel,
        plannedOrders,
        'user_channel_disconnected',
        idempotencyKey,
        executionId,
        idleState
      );
    }
  }

  if (!isEv && policy.rejectDelayed === false) {
    throw new Error('ExecutionAgent requires rejectDelayed=true for near-risk-free mode');
  }

  const decisionLatencyMs = nowMs - opportunity.detectedAt;
  if (policy.maxDecisionLatencyMs > 0 && decisionLatencyMs > policy.maxDecisionLatencyMs) {
    return blockedDecision(
      requiresUserChannel,
      plannedOrders,
      'decision_latency_exceeded',
      idempotencyKey,
      executionId,
      idleState,
      [
        {
          type: 'metric',
          event: {
            type: 'slo_violation',
            timestamp: nowMs,
            data: {
              sloName: 'decision_latency',
              threshold: policy.maxDecisionLatencyMs,
              actual: decisionLatencyMs,
              marketId: opportunity.marketId,
              timestampMs: nowMs
            }
          }
        },
        {
          type: 'incident',
          incident: {
            marketId: opportunity.marketId,
            reason: 'latency_exceeded',
            timestamp: nowMs,
            opportunityId: opportunity.id,
            detail: { decisionLatencyMs, maxDecisionLatencyMs: policy.maxDecisionLatencyMs }
          }
        }
      ]
    );
  }

  if (metrics) {
    const otrWindowMs = policy.orderToTradeWindowMs;
    const stats = metrics.getOrderStats(opportunity.marketId, otrWindowMs, nowMs);
    const projectedRatio = (stats.orders + plannedOrders) / Math.max(stats.fills, 1);
    if (projectedRatio > policy.maxOrderToTradeRatio) {
      return blockedDecision(
        requiresUserChannel,
        plannedOrders,
        'otr_exceeded',
        idempotencyKey,
        executionId,
        idleState,
        [
          {
            type: 'incident',
            incident: {
              marketId: opportunity.marketId,
              reason: 'otr_exceeded',
              timestamp: nowMs,
              opportunityId: opportunity.id,
              detail: {
                windowMs: otrWindowMs,
                orders: stats.orders,
                fills: stats.fills,
                projectedRatio,
                maxOrderToTradeRatio: policy.maxOrderToTradeRatio
              }
            }
          }
        ]
      );
    }

    if (policy.maxOrdersPerMinute > 0) {
      const velocityWindowMs = policy.orderVelocityWindowMs;
      const currentOrders = metrics.getOrderVelocity(velocityWindowMs, nowMs);
      const projectedOrders = currentOrders + plannedOrders;
      if (projectedOrders > policy.maxOrdersPerMinute) {
        return blockedDecision(
          requiresUserChannel,
          plannedOrders,
          'velocity_throttle',
          idempotencyKey,
          executionId,
          idleState,
          [
            {
              type: 'metric',
              event: {
                type: 'slo_violation',
                timestamp: nowMs,
                data: {
                  sloName: 'order_velocity',
                  threshold: policy.maxOrdersPerMinute,
                  actual: projectedOrders,
                  windowMs: velocityWindowMs,
                  marketId: opportunity.marketId,
                  timestampMs: nowMs
                }
              }
            },
            {
              type: 'incident',
              incident: {
                marketId: opportunity.marketId,
                reason: 'velocity_throttle',
                timestamp: nowMs,
                opportunityId: opportunity.id,
                detail: {
                  windowMs: velocityWindowMs,
                  orders: currentOrders,
                  projectedOrders,
                  maxOrdersPerMinute: policy.maxOrdersPerMinute
                }
              }
            }
          ]
        );
      }
    }

    if (policy.maxDelayedAckRate > 0) {
      const delayedAckRate = metrics.getDelayedAckRate(opportunity.marketId, otrWindowMs, nowMs);
      if (delayedAckRate > policy.maxDelayedAckRate) {
        return blockedDecision(
          requiresUserChannel,
          plannedOrders,
          'delayed_ack_rate_exceeded',
          idempotencyKey,
          executionId,
          idleState,
          [
            {
              type: 'metric',
              event: {
                type: 'slo_violation',
                timestamp: nowMs,
                data: {
                  sloName: 'delayed_ack_rate',
                  threshold: policy.maxDelayedAckRate,
                  actual: delayedAckRate,
                  marketId: opportunity.marketId,
                  timestampMs: nowMs
                }
              }
            },
            {
              type: 'incident',
              incident: {
                marketId: opportunity.marketId,
                reason: 'latency_exceeded',
                timestamp: nowMs,
                opportunityId: opportunity.id,
                detail: {
                  delayedAckRate,
                  maxDelayedAckRate: policy.maxDelayedAckRate,
                  windowMs: otrWindowMs
                }
              }
            }
          ]
        );
      }
    }
  }

  if (yesBook?.bestAsk && noBook?.bestAsk) {
    const bandFraction = policy.priceBandBps / 10000;
    if (isEv && opportunity.side) {
      const sideBestAsk = opportunity.side === 'yes' ? yesBook.bestAsk : noBook.bestAsk;
      const expected = opportunity.side === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
      const deviation = expected > 0 ? Math.abs(sideBestAsk.price - expected) / expected : 0;
      if (deviation > bandFraction) {
        return blockedPriceMove(
          false,
          plannedOrders,
          opportunity,
          nowMs,
          idempotencyKey,
          executionId,
          idleState,
          {
            side: opportunity.side,
            deviation,
            bandFraction,
            observed: sideBestAsk.price,
            expected
          }
        );
      }
    } else {
      const yesDeviation =
        opportunity.yesPrice > 0 ? Math.abs(yesBook.bestAsk.price - opportunity.yesPrice) / opportunity.yesPrice : 0;
      const noDeviation =
        opportunity.noPrice > 0 ? Math.abs(noBook.bestAsk.price - opportunity.noPrice) / opportunity.noPrice : 0;
      if (yesDeviation > bandFraction || noDeviation > bandFraction) {
        return blockedPriceMove(
          false,
          plannedOrders,
          opportunity,
          nowMs,
          idempotencyKey,
          executionId,
          idleState,
          {
            yesDeviation,
            noDeviation,
            bandFraction,
            yesObserved: yesBook.bestAsk.price,
            noObserved: noBook.bestAsk.price,
            yesExpected: opportunity.yesPrice,
            noExpected: opportunity.noPrice
          }
        );
      }
    }
  }

  return {
    requiresUserChannel,
    plannedOrders,
    effects: []
  };
}

function blockedPriceMove(
  requiresUserChannel: boolean,
  plannedOrders: number,
  opportunity: ArbitrageOpportunity,
  nowMs: number,
  idempotencyKey: string,
  executionId: string,
  idleState: ExecutionState,
  detail: Record<string, unknown>
): ExecutionPreflightDecision {
  return blockedDecision(
    requiresUserChannel,
    plannedOrders,
    'price_moved',
    idempotencyKey,
    executionId,
    idleState,
    [
      {
        type: 'incident',
        incident: {
          marketId: opportunity.marketId,
          reason: 'price_moved',
          timestamp: nowMs,
          opportunityId: opportunity.id,
          detail
        }
      }
    ]
  );
}

function blockedDecision(
  requiresUserChannel: boolean,
  plannedOrders: number,
  reason: string,
  idempotencyKey: string,
  executionId: string,
  idleState: ExecutionState,
  effects: ExecutionPreflightEffect[] = []
): ExecutionPreflightDecision {
  return {
    requiresUserChannel,
    plannedOrders,
    effects,
    blocked: {
      kind: plannedOrders === 1 ? 'ev' : 'paired',
      status: 'blocked',
      reason,
      idempotencyKey,
      executionId,
      state: idleState
    }
  };
}
