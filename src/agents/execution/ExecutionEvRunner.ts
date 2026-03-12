import {
  buildFokBuyOrder,
  coerceOrderResponse,
  isDelayedOrderResponse,
  isOrderFailure,
  toClobOrderPayload,
  type ExecutionState
} from '../../domain/execution.js';
import type { IncidentReason } from '../../domain/incident.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderResponse } from '../../domain/types.js';
import type { PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type {
  ExecutionEvAttemptResult,
  ExecutionEvParams,
  ExecutionFillServices,
  ExecutionIdempotencyServices
} from './ExecutionContracts.js';

interface ExecutionEvDeps {
  clob: PolymarketClob;
  portfolio?: PortfolioAgent;
  incidentTracker?: IncidentTracker;
  metrics?: MetricsStore;
  idempotency: Pick<ExecutionIdempotencyServices, 'markFailed' | 'saveRecord'>;
  fills: Pick<ExecutionFillServices, 'waitForFillOutcome'>;
  withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T>;
  isTimeoutError(error: unknown): error is { phase: string; timeoutMs: number };
  coerceNonceValue(nonce: string): string | number;
  extractOrderId(order?: OrderResponse): string | undefined;
}

export class ExecutionEvRunner {
  constructor(private readonly deps: ExecutionEvDeps) {}

  async execute(
    opportunity: ArbitrageOpportunity,
    size: number,
    params: ExecutionEvParams
  ): Promise<ExecutionEvAttemptResult> {
    const side = opportunity.side;
    const {
      nowMs,
      idempotencyKey,
      executionId,
      idleState,
      timeouts,
      trackedOrderIds
    } = params;
    if (!side) {
      return {
        kind: 'ev',
        status: 'blocked',
        reason: 'ev_missing_side',
        idempotencyKey,
        executionId,
        state: idleState
      };
    }
    const { record } = params;

    const tokenId = side === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;
    const price = side === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
    if (!Number.isFinite(price) || price <= 0) {
      return {
        kind: 'ev',
        status: 'blocked',
        reason: 'invalid_price',
        idempotencyKey,
        executionId,
        state: idleState
      };
    }

    this.deps.metrics?.recordLatency({
      stage: 'detected',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: opportunity.detectedAt,
      latencyMs: 0,
      cumulativeMs: 0
    });

    this.deps.portfolio?.expectFill({
      opportunityId: opportunity.id,
      tokenId,
      expectedSize: size,
      expectedPrice: price,
      timestamp: nowMs
    });

    const submitMs = Date.now();
    this.deps.metrics?.recordLatency({
      stage: 'submitted',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: submitMs,
      latencyMs: submitMs - opportunity.detectedAt,
      cumulativeMs: submitMs - opportunity.detectedAt
    });
    this.deps.metrics?.recordOrderAttempt(opportunity.marketId, submitMs);

    const payload = toClobOrderPayload(
      buildFokBuyOrder({
        tokenId,
        size,
        price,
        clientOrderId: record.key
      })
    );
    const payloadWithNonce = {
      ...payload,
      nonce: this.deps.coerceNonceValue(record.nonce)
    };

    let response: unknown;
    try {
      response = await this.deps.withTimeout(
        this.deps.clob.createOrder(payloadWithNonce),
        timeouts.submitTimeoutMs,
        `ev_submit_${side}`
      );
    } catch (error) {
      const failureAtMs = Date.now();
      const incidentReason: IncidentReason = this.deps.isTimeoutError(error) ? 'order_timeout' : 'order_failed';
      const detail = this.deps.isTimeoutError(error)
        ? { phase: error.phase, timeoutMs: error.timeoutMs }
        : { error: error instanceof Error ? error.message : String(error) };
      this.deps.idempotency.markFailed(record.key, failureAtMs);
      this.deps.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: incidentReason,
        timestamp: failureAtMs,
        opportunityId: opportunity.id,
        detail
      });
      return {
        kind: 'ev',
        status: 'failed',
        reason: incidentReason,
        idempotencyKey,
        executionId,
        state: 'failed',
        side
      };
    }

    const ackMs = Date.now();
    let order = coerceOrderResponse(response);
    const orderId = this.deps.extractOrderId(order) ?? record.orderId;
    trackedOrderIds.length = 0;
    if (orderId) trackedOrderIds.push(orderId);
    if (orderId && !this.deps.extractOrderId(order)) {
      order = { ...order, orderID: orderId };
    }

    this.deps.idempotency.saveRecord({
      ...record,
      orderId,
      status: orderId ? 'submitted' : record.status,
      updatedAt: ackMs
    });

    if (this.deps.metrics) {
      if (isDelayedOrderResponse(response)) {
        this.deps.metrics.recordDelayedAck(opportunity.marketId, ackMs);
      }
      this.deps.metrics.recordLatency({
        stage: 'acked',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: ackMs,
        latencyMs: ackMs - submitMs,
        cumulativeMs: ackMs - opportunity.detectedAt
      });
    }

    if (isDelayedOrderResponse(response)) {
      this.deps.idempotency.markFailed(record.key, ackMs);
      this.deps.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_delayed',
        timestamp: ackMs,
        opportunityId: opportunity.id,
        detail: { order }
      });
      return failedOrder(side, order, idempotencyKey, executionId, 'order_delayed');
    }

    if (isOrderFailure(response)) {
      this.deps.idempotency.markFailed(record.key, ackMs);
      this.deps.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_rejected',
        timestamp: ackMs,
        opportunityId: opportunity.id,
        detail: { order }
      });
      return failedOrder(side, order, idempotencyKey, executionId, 'order_rejected');
    }

    if (!orderId) {
      const failureAtMs = Date.now();
      this.deps.idempotency.markFailed(record.key, failureAtMs);
      this.deps.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_failed',
        timestamp: failureAtMs,
        opportunityId: opportunity.id,
        detail: { orderId, order }
      });
      return failedOrder(side, order, idempotencyKey, executionId, 'order_failed');
    }

    const remainingFillTimeoutMs =
      timeouts.fillTimeoutMs > 0 ? Math.max(0, timeouts.fillTimeoutMs - (Date.now() - ackMs)) : 0;
    const outcome = await this.deps.fills.waitForFillOutcome(orderId, size, remainingFillTimeoutMs);
    const fillMs = Math.max(ackMs, outcome.observedAtMs);

    if (outcome.fullyFilled) {
      if (this.deps.metrics) {
        this.deps.metrics.recordFill(opportunity.marketId, fillMs);
        this.deps.metrics.recordLatency({
          stage: 'filled',
          opportunityId: opportunity.id,
          marketId: opportunity.marketId,
          timestampMs: fillMs,
          latencyMs: fillMs - ackMs,
          cumulativeMs: fillMs - opportunity.detectedAt
        });
        this.deps.metrics.recordLatency({
          stage: 'complete',
          opportunityId: opportunity.id,
          marketId: opportunity.marketId,
          timestampMs: fillMs,
          latencyMs: fillMs - opportunity.detectedAt,
          cumulativeMs: fillMs - opportunity.detectedAt
        });
      }

      this.deps.idempotency.saveRecord({
        ...record,
        orderId,
        status: 'confirmed',
        updatedAt: fillMs
      });

      return submittedOrder(side, order, idempotencyKey, executionId, 'complete');
    }

    const failureAtMs = Date.now();
    const failureReason: IncidentReason = outcome.timedOut ? 'order_timeout' : 'order_failed';
    this.deps.idempotency.markFailed(record.key, failureAtMs);
    this.deps.incidentTracker?.record({
      marketId: opportunity.marketId,
      reason: failureReason,
      timestamp: failureAtMs,
      opportunityId: opportunity.id,
      detail: { outcome, orderId }
    });

    return {
      ...failedOrder(side, order, idempotencyKey, executionId, failureReason),
      state: outcome.timedOut ? 'timeout' : 'failed'
    };
  }
}

function submittedOrder(
  side: 'yes' | 'no',
  order: OrderResponse,
  idempotencyKey: string,
  executionId: string,
  state: ExecutionState
): ExecutionEvAttemptResult {
  return {
    kind: 'ev',
    status: 'submitted',
    side,
    order,
    idempotencyKey,
    executionId,
    state
  };
}

function failedOrder(
  side: 'yes' | 'no',
  order: OrderResponse,
  idempotencyKey: string,
  executionId: string,
  reason: string
): ExecutionEvAttemptResult {
  return {
    kind: 'ev',
    status: 'failed',
    reason,
    side,
    order,
    idempotencyKey,
    executionId,
    state: 'failed'
  };
}
