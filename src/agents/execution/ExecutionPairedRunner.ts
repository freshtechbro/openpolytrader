import { buildFokBuyOrder, coerceOrderResponse, createInitialExecutionState, isDelayedOrderResponse, isOrderFailure, toClobOrderPayload, type PairedExecutionState } from '../../domain/execution.js';
import type { IncidentReason } from '../../domain/incident.js';
import type { IdempotencyRecord } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderResponse } from '../../domain/types.js';
import type { PolymarketClob } from '../../services/PolymarketClob.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { PortfolioAgent } from '../portfolio/PortfolioAgent.js';
import type { ExecutionPairedAttemptResult } from './ExecutionContracts.js';

interface ExecutionPairedTimeouts {
  submitTimeoutMs: number;
  ackTimeoutMs: number;
  fillTimeoutMs: number;
}

interface ExecutionPairedParams {
  opportunity: ArbitrageOpportunity;
  size: number;
  nowMs: number;
  timeouts: ExecutionPairedTimeouts;
  idempotencyKey: string;
  executionId: string;
  yesIdempotencyKey: string;
  noIdempotencyKey: string;
  yesRecord: IdempotencyRecord;
  noRecord: IdempotencyRecord;
  trackedOrderIds: string[];
  requiresUserChannel: boolean;
}

interface ExecutionPairedDeps {
  clob: PolymarketClob;
  metrics?: MetricsStore;
  portfolio?: PortfolioAgent;
  policy: { maxLegSkewMs: number };
  transition(current: PairedExecutionState, event: { type: string; atMs: number; [key: string]: unknown }): PairedExecutionState;
  waitForFillOutcome(orderId: string, desiredSize: number, timeoutMs: number): Promise<{
    orderId: string;
    sizeMatched: number;
    fullyFilled: boolean;
    cancelled: boolean;
    timedOut: boolean;
    observedAtMs: number;
  }>;
  saveIdempotencyRecord(record: IdempotencyRecord): void;
  withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T>;
  isTimeoutError(error: unknown): error is { phase: string; timeoutMs: number };
  coerceNonceValue(nonce: string): string | number;
  extractOrderId(order?: OrderResponse): string | undefined;
  handleFailure(
    current: PairedExecutionState,
    atMs: number,
    size: number,
    resultReason: string,
    incidentReason: IncidentReason,
    detail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<ExecutionPairedAttemptResult>;
  handleObservedPartialFill(
    current: PairedExecutionState,
    atMs: number,
    filledLeg: 'yes' | 'no',
    filledSize: number,
    failureReason: string,
    failureDetail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<ExecutionPairedAttemptResult>;
}

export class ExecutionPairedRunner {
  constructor(private readonly deps: ExecutionPairedDeps) {}

  async execute(params: ExecutionPairedParams): Promise<ExecutionPairedAttemptResult> {
    const {
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
      requiresUserChannel
    } = params;

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

    this.deps.metrics?.recordLatency({
      stage: 'detected',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: detectedAt,
      latencyMs: 0,
      cumulativeMs: 0
    });

    if (this.deps.portfolio) {
      this.deps.portfolio.expectFill({
        opportunityId: opportunity.id,
        tokenId: opportunity.yesTokenId,
        expectedSize: size,
        expectedPrice: opportunity.yesPrice,
        timestamp: nowMs
      });
      this.deps.portfolio.expectFill({
        opportunityId: opportunity.id,
        tokenId: opportunity.noTokenId,
        expectedSize: size,
        expectedPrice: opportunity.noPrice,
        timestamp: nowMs
      });
    }

    let state = this.deps.transition(initialState, { type: 'SUBMIT_STARTED', atMs: nowMs });

    const submitMs = Date.now();
    state = this.deps.transition(state, { type: 'SUBMIT_YES', atMs: submitMs });
    state = this.deps.transition(state, { type: 'SUBMIT_NO', atMs: submitMs });

    const yesPayloadWithNonce = {
      ...toClobOrderPayload(
        buildFokBuyOrder({
          tokenId: opportunity.yesTokenId,
          size,
          price: opportunity.yesPrice,
          clientOrderId: yesIdempotencyKey
        })
      ),
      nonce: this.deps.coerceNonceValue(yesRecord.nonce)
    };
    const noPayloadWithNonce = {
      ...toClobOrderPayload(
        buildFokBuyOrder({
          tokenId: opportunity.noTokenId,
          size,
          price: opportunity.noPrice,
          clientOrderId: noIdempotencyKey
        })
      ),
      nonce: this.deps.coerceNonceValue(noRecord.nonce)
    };

    this.deps.metrics?.recordLatency({
      stage: 'submitted',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: submitMs,
      latencyMs: submitMs - detectedAt,
      cumulativeMs: submitMs - detectedAt
    });
    this.deps.metrics?.recordOrderAttempt(opportunity.marketId, nowMs);
    this.deps.metrics?.recordOrderAttempt(opportunity.marketId, nowMs);

    const submitLeg = (
      payload: Record<string, unknown>,
      record: IdempotencyRecord
    ): Promise<{ response: unknown; ackMs: number; reused: boolean }> => {
      if (record.status !== 'failed' && record.orderId) {
        return Promise.resolve({
          response: { status: 'LIVE', success: true },
          ackMs: Date.now(),
          reused: true
        });
      }
      return this.deps.clob.createOrder(payload).then((response) => ({
        response,
        ackMs: Date.now(),
        reused: false
      }));
    };

    const yesPromise = this.deps.withTimeout(submitLeg(yesPayloadWithNonce, yesRecord), timeouts.submitTimeoutMs, 'submit_yes');
    const noPromise = this.deps.withTimeout(submitLeg(noPayloadWithNonce, noRecord), timeouts.submitTimeoutMs, 'submit_no');

    const results = await Promise.allSettled([yesPromise, noPromise]);
    const yesResult = results[0];
    const noResult = results[1];
    const timeoutFailure = results.find(
      (result) => result.status === 'rejected' && this.deps.isTimeoutError(result.reason)
    ) as PromiseRejectedResult | undefined;
    const rejectionFailure = results.find(
      (result) => result.status === 'rejected' && !this.deps.isTimeoutError(result.reason)
    ) as PromiseRejectedResult | undefined;

    if (timeoutFailure || rejectionFailure) {
      const timeoutError = timeoutFailure?.reason;
      const message =
        rejectionFailure?.reason instanceof Error
          ? rejectionFailure.reason.message
          : String(rejectionFailure?.reason ?? 'order_failed');
      const detail = this.deps.isTimeoutError(timeoutError)
        ? { phase: timeoutError.phase, timeoutMs: timeoutError.timeoutMs }
        : { error: message };
      const yesResponse =
        yesResult.status === 'fulfilled' ? coerceOrderResponse(yesResult.value.response) : undefined;
      const noResponse =
        noResult.status === 'fulfilled' ? coerceOrderResponse(noResult.value.response) : undefined;
      const incidentReason: IncidentReason = this.deps.isTimeoutError(timeoutError) ? 'order_timeout' : 'order_failed';
      return this.deps.handleFailure(state, Date.now(), size, incidentReason, incidentReason, detail, yesResponse, noResponse);
    }

    const [yesFulfilled, noFulfilled] = results as [
      PromiseFulfilledResult<{ response: unknown; ackMs: number; reused: boolean }>,
      PromiseFulfilledResult<{ response: unknown; ackMs: number; reused: boolean }>
    ];
    const { response: yesOrder, ackMs: yesAckMs } = yesFulfilled.value;
    const { response: noOrder, ackMs: noAckMs } = noFulfilled.value;

    let yesResponse = coerceOrderResponse(yesOrder);
    let noResponse = coerceOrderResponse(noOrder);
    const yesOrderId = this.deps.extractOrderId(yesResponse) ?? yesRecord.orderId;
    const noOrderId = this.deps.extractOrderId(noResponse) ?? noRecord.orderId;
    trackedOrderIds.length = 0;
    if (yesOrderId) trackedOrderIds.push(yesOrderId);
    if (noOrderId) trackedOrderIds.push(noOrderId);
    if (yesOrderId && !this.deps.extractOrderId(yesResponse)) yesResponse = { ...yesResponse, orderID: yesOrderId };
    if (noOrderId && !this.deps.extractOrderId(noResponse)) noResponse = { ...noResponse, orderID: noOrderId };

    this.deps.saveIdempotencyRecord({ ...yesRecord, orderId: yesOrderId, status: yesOrderId ? 'submitted' : yesRecord.status, updatedAt: yesAckMs });
    this.deps.saveIdempotencyRecord({ ...noRecord, orderId: noOrderId, status: noOrderId ? 'submitted' : noRecord.status, updatedAt: noAckMs });

    state = this.deps.transition(state, { type: 'ACK_YES', atMs: yesAckMs, order: yesResponse });
    state = this.deps.transition(state, { type: 'ACK_NO', atMs: noAckMs, order: noResponse });

    if (this.deps.metrics) {
      if (isDelayedOrderResponse(yesOrder)) this.deps.metrics.recordDelayedAck(opportunity.marketId, yesAckMs);
      if (isDelayedOrderResponse(noOrder)) this.deps.metrics.recordDelayedAck(opportunity.marketId, noAckMs);
    }

    const ackStageMs = Math.max(yesAckMs, noAckMs);
    this.deps.metrics?.recordLatency({
      stage: 'acked',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: ackStageMs,
      latencyMs: ackStageMs - submitMs,
      cumulativeMs: ackStageMs - detectedAt
    });

    const ackLatencyMs = ackStageMs - submitMs;
    if (timeouts.ackTimeoutMs > 0 && ackLatencyMs > timeouts.ackTimeoutMs) {
      return this.deps.handleFailure(
        state,
        ackStageMs,
        size,
        'order_timeout',
        'order_timeout',
        { phase: 'ack', ackLatencyMs, ackTimeoutMs: timeouts.ackTimeoutMs },
        yesResponse,
        noResponse
      );
    }

    if (isDelayedOrderResponse(yesOrder) || isDelayedOrderResponse(noOrder)) {
      return this.deps.handleFailure(state, ackStageMs, size, 'order_delayed', 'order_delayed', { yesOrder, noOrder }, yesResponse, noResponse);
    }

    if (isOrderFailure(yesOrder) || isOrderFailure(noOrder)) {
      return this.deps.handleFailure(state, ackStageMs, size, 'order_rejected', 'order_rejected', { yesOrder, noOrder }, yesResponse, noResponse);
    }

    const legSkewMs = Math.abs(yesAckMs - noAckMs);
    if (this.deps.policy.maxLegSkewMs > 0 && legSkewMs > this.deps.policy.maxLegSkewMs) {
      return this.deps.handleFailure(
        state,
        ackStageMs,
        size,
        'leg_skew_exceeded',
        'latency_exceeded',
        { legSkewMs, maxLegSkewMs: this.deps.policy.maxLegSkewMs, yesAckMs, noAckMs },
        yesResponse,
        noResponse
      );
    }

    const remainingFillTimeoutMs =
      timeouts.fillTimeoutMs > 0 ? Math.max(0, timeouts.fillTimeoutMs - (Date.now() - ackStageMs)) : 0;

    if (requiresUserChannel && remainingFillTimeoutMs > 0) {
      if (!yesOrderId || !noOrderId) {
        return this.deps.handleFailure(
          state,
          Date.now(),
          size,
          'order_failed',
          'order_failed',
          { yesOrderId, noOrderId },
          yesResponse,
          noResponse
        );
      }

      const [yesOutcome, noOutcome] = await Promise.all([
        this.deps.waitForFillOutcome(yesOrderId, size, remainingFillTimeoutMs),
        this.deps.waitForFillOutcome(noOrderId, size, remainingFillTimeoutMs)
      ]);
      const fillMs = Math.max(yesOutcome.observedAtMs, noOutcome.observedAtMs);

      if (yesOutcome.fullyFilled && noOutcome.fullyFilled) {
        state = this.deps.transition(state, { type: 'FILL_YES', atMs: fillMs });
        state = this.deps.transition(state, { type: 'FILL_NO', atMs: fillMs });
        if (this.deps.metrics) {
          this.deps.metrics.recordFill(opportunity.marketId, nowMs);
          this.deps.metrics.recordFill(opportunity.marketId, nowMs);
          this.deps.metrics.recordLatency({
            stage: 'filled',
            opportunityId: opportunity.id,
            marketId: opportunity.marketId,
            timestampMs: fillMs,
            latencyMs: fillMs - ackStageMs,
            cumulativeMs: fillMs - detectedAt
          });
        }
        state = this.deps.transition(state, { type: 'COMPLETE', atMs: fillMs });
        this.deps.metrics?.recordLatency({
          stage: 'complete',
          opportunityId: opportunity.id,
          marketId: opportunity.marketId,
          timestampMs: fillMs,
          latencyMs: fillMs - detectedAt,
          cumulativeMs: fillMs - detectedAt
        });
        if (yesOrderId) this.deps.saveIdempotencyRecord({ ...yesRecord, orderId: yesOrderId, status: 'confirmed', updatedAt: fillMs });
        if (noOrderId) this.deps.saveIdempotencyRecord({ ...noRecord, orderId: noOrderId, status: 'confirmed', updatedAt: fillMs });
        return {
          kind: 'paired',
          status: 'submitted',
          yesOrder: yesResponse,
          noOrder: noResponse,
          idempotencyKey,
          executionId,
          state: state.state
        };
      }

      const filledLeg =
        yesOutcome.sizeMatched > 0 && noOutcome.sizeMatched <= 0
          ? 'yes'
          : noOutcome.sizeMatched > 0 && yesOutcome.sizeMatched <= 0
            ? 'no'
            : null;
      if (!filledLeg) {
        const timedOut = yesOutcome.timedOut || noOutcome.timedOut;
        return this.deps.handleFailure(
          state,
          fillMs,
          size,
          timedOut ? 'order_timeout' : 'order_failed',
          timedOut ? 'order_timeout' : 'order_failed',
          { yesOutcome, noOutcome, fillMs },
          yesResponse,
          noResponse
        );
      }

      const filledSize = Math.min(filledLeg === 'yes' ? yesOutcome.sizeMatched : noOutcome.sizeMatched, size);
      const failureReason = yesOutcome.timedOut || noOutcome.timedOut ? 'order_timeout' : 'order_failed';
      return this.deps.handleObservedPartialFill(
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
    state = this.deps.transition(state, { type: 'FILL_YES', atMs: fillMs });
    state = this.deps.transition(state, { type: 'FILL_NO', atMs: fillMs });
    if (this.deps.metrics) {
      this.deps.metrics.recordFill(opportunity.marketId, nowMs);
      this.deps.metrics.recordFill(opportunity.marketId, nowMs);
      this.deps.metrics.recordLatency({
        stage: 'filled',
        opportunityId: opportunity.id,
        marketId: opportunity.marketId,
        timestampMs: fillMs,
        latencyMs: fillMs - ackStageMs,
        cumulativeMs: fillMs - detectedAt
      });
    }
    state = this.deps.transition(state, { type: 'COMPLETE', atMs: fillMs });
    this.deps.metrics?.recordLatency({
      stage: 'complete',
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      timestampMs: fillMs,
      latencyMs: fillMs - detectedAt,
      cumulativeMs: fillMs - detectedAt
    });
    if (yesOrderId) this.deps.saveIdempotencyRecord({ ...yesRecord, orderId: yesOrderId, status: 'confirmed', updatedAt: fillMs });
    if (noOrderId) this.deps.saveIdempotencyRecord({ ...noRecord, orderId: noOrderId, status: 'confirmed', updatedAt: fillMs });
    return {
      kind: 'paired',
      status: 'submitted',
      yesOrder: yesResponse,
      noOrder: noResponse,
      idempotencyKey,
      executionId,
      state: state.state
    };
  }
}
