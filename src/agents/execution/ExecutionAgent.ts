import type { TradePolicy } from '../../config/policy.js';
import { createIdempotencyKey } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderResponse } from '../../domain/types.js';
import { buildFokBuyOrder, coerceOrderResponse, isDelayedOrderResponse, isOrderFailure, toClobOrderPayload } from '../../domain/execution.js';
import { PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';

export interface ExecutionResult {
  status: 'submitted' | 'failed' | 'blocked';
  reason?: string;
  yesOrder?: OrderResponse;
  noOrder?: OrderResponse;
  idempotencyKey: string;
}

export interface ExecutionAgentConfig {
  tradingEnabled: boolean;
}

export class ExecutionAgent {
  private tradingEnabled: boolean;

  constructor(
    private policy: TradePolicy,
    private clob: PolymarketClob,
    private incidentTracker?: IncidentTracker,
    config?: ExecutionAgentConfig
  ) {
    this.tradingEnabled = config?.tradingEnabled ?? false;
  }

  isTradingEnabled(): boolean {
    return this.tradingEnabled;
  }

  async executeArbitrage(opportunity: ArbitrageOpportunity, size: number): Promise<ExecutionResult> {
    if (!this.tradingEnabled) {
      return {
        status: 'blocked',
        reason: 'trading_disabled',
        idempotencyKey: createIdempotencyKey(
          `${opportunity.marketId}:${opportunity.yesTokenId}:${opportunity.noTokenId}:${opportunity.detectedAt}`
        )
      };
    }

    if (this.policy.rejectDelayed === false) {
      throw new Error('ExecutionAgent requires rejectDelayed=true for near-risk-free mode');
    }

    const idempotencyKey = createIdempotencyKey(
      `${opportunity.marketId}:${opportunity.yesTokenId}:${opportunity.noTokenId}:${opportunity.detectedAt}`
    );

    const yesPayload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId: opportunity.yesTokenId,
        size,
        price: opportunity.yesPrice,
        clientOrderId: `${idempotencyKey}:yes`
      })
    );

    const noPayload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId: opportunity.noTokenId,
        size,
        price: opportunity.noPrice,
        clientOrderId: `${idempotencyKey}:no`
      })
    );

    const [yesOrder, noOrder] = await Promise.all([
      this.clob.createOrder(yesPayload),
      this.clob.createOrder(noPayload)
    ]);

    if (isDelayedOrderResponse(yesOrder) || isDelayedOrderResponse(noOrder)) {
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_delayed',
        timestamp: Date.now(),
        detail: { yesOrder, noOrder }
      });
      return {
        status: 'failed',
        reason: 'order_delayed',
        yesOrder: coerceOrderResponse(yesOrder),
        noOrder: coerceOrderResponse(noOrder),
        idempotencyKey
      };
    }

    if (isOrderFailure(yesOrder) || isOrderFailure(noOrder)) {
      this.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_rejected',
        timestamp: Date.now(),
        detail: { yesOrder, noOrder }
      });
      return {
        status: 'failed',
        reason: 'order_rejected',
        yesOrder: coerceOrderResponse(yesOrder),
        noOrder: coerceOrderResponse(noOrder),
        idempotencyKey
      };
    }

    return {
      status: 'submitted',
      yesOrder: coerceOrderResponse(yesOrder),
      noOrder: coerceOrderResponse(noOrder),
      idempotencyKey
    };
  }
}

