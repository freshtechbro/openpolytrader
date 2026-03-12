import { buildFakSellOrder, coerceOrderResponse, type PairedExecutionState, toClobOrderPayload, type UnwindResult, type ExecutionEvent } from '../../domain/execution.js';
import type { IncidentReason } from '../../domain/incident.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { OrderResponse } from '../../domain/types.js';
import type { CancelOrdersResponse, PolymarketClob } from '../../services/PolymarketClob.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { ExecutionPairedAttemptResult } from './ExecutionContracts.js';

interface ExecutionFailureRecoveryDeps {
  clob: PolymarketClob;
  incidentTracker?: IncidentTracker;
  opportunity: ArbitrageOpportunity;
  context?: { yesBook?: OrderBookState; noBook?: OrderBookState };
  timeouts: { submitTimeoutMs: number; cancelTimeoutMs: number };
  idempotencyKey: string;
  executionId: string;
  yesIdempotencyKey: string;
  noIdempotencyKey: string;
  markIdempotencyFailed(key: string, nowMs: number): void;
  resolveUnwindTickSize(
    leg: 'yes' | 'no',
    opportunity: ArbitrageOpportunity,
    context?: { yesBook?: OrderBookState; noBook?: OrderBookState }
  ): number;
  calculateUnwindPrice(
    entryPrice: number,
    tickSize: number,
    advisory?: { marketId: string; opportunityId: string; nowMs?: number }
  ): number;
  recordUnwindPortfolio(marketId: string, tokenId: string, entryPrice: number, unwindPrice: number, size: number): void;
  transition(current: PairedExecutionState, event: ExecutionEvent): PairedExecutionState;
  withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T>;
  extractOrderId(order?: OrderResponse): string | undefined;
  isOrderSuccessful(order?: OrderResponse): boolean;
  isCancelFailure(response: CancelOrdersResponse | null | undefined, expectedId?: string): boolean;
  formatCancelError(error: unknown): string;
}

export class ExecutionFailureRecovery {
  constructor(private readonly deps: ExecutionFailureRecoveryDeps) {}

  async handleFailure(
    current: PairedExecutionState,
    atMs: number,
    size: number,
    resultReason: string,
    incidentReason: IncidentReason,
    detail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<ExecutionPairedAttemptResult> {
    const filledLeg = this.resolvePartialFillLeg(yesOrder, noOrder);
    if (!filledLeg) {
      return this.failWithCancel(current, atMs, resultReason, incidentReason, detail, yesOrder, noOrder);
    }
    return this.handlePartialFill(
      current,
      atMs,
      filledLeg,
      size,
      resultReason,
      detail,
      yesOrder,
      noOrder
    );
  }

  async handleObservedPartialFill(
    current: PairedExecutionState,
    atMs: number,
    filledLeg: 'yes' | 'no',
    filledSize: number,
    failureReason: string,
    failureDetail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<Awaited<ReturnType<ExecutionFailureRecovery['handleFailure']>>> {
    return this.handlePartialFill(
      current,
      atMs,
      filledLeg,
      filledSize,
      failureReason,
      failureDetail,
      yesOrder,
      noOrder
    );
  }

  private async failWithCancel(
    current: PairedExecutionState,
    atMs: number,
    resultReason: string,
    incidentReason: IncidentReason,
    detail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<Awaited<ReturnType<ExecutionFailureRecovery['handleFailure']>>> {
    let next = current;
    if (current.state !== 'cancelling') {
      next = this.deps.transition(current, { type: 'CANCEL_STARTED', atMs });
    }

    const [yesCancel, noCancel] = await Promise.all([
      this.cancelLeg('yes', yesOrder, this.deps.opportunity.yesTokenId),
      this.cancelLeg('no', noOrder, this.deps.opportunity.noTokenId)
    ]);
    const cancelDetail = {
      cancelTimeoutMs: this.deps.timeouts.cancelTimeoutMs,
      yes: yesCancel,
      no: noCancel
    };

    this.deps.markIdempotencyFailed(this.deps.yesIdempotencyKey, atMs);
    this.deps.markIdempotencyFailed(this.deps.noIdempotencyKey, atMs);

    if (!yesCancel.ok || !noCancel.ok) {
      this.deps.incidentTracker?.record({
        marketId: this.deps.opportunity.marketId,
        reason: 'order_cancel_failed',
        timestamp: atMs,
        opportunityId: this.deps.opportunity.id,
        detail: cancelDetail
      });
    }

    next = this.deps.transition(next, { type: 'FAILED', atMs, reason: resultReason });
    this.deps.incidentTracker?.record({
      marketId: this.deps.opportunity.marketId,
      reason: incidentReason,
      timestamp: atMs,
      opportunityId: this.deps.opportunity.id,
      detail: { ...detail, cancel: cancelDetail, cancelTimeoutMs: this.deps.timeouts.cancelTimeoutMs }
    });
    return {
      kind: 'paired',
      status: 'failed',
      reason: resultReason,
      yesOrder,
      noOrder,
      idempotencyKey: this.deps.idempotencyKey,
      executionId: this.deps.executionId,
      state: next.state
    };
  }

  private async handlePartialFill(
    current: PairedExecutionState,
    atMs: number,
    filledLeg: 'yes' | 'no',
    filledSize: number,
    failureReason: string,
    failureDetail: Record<string, unknown>,
    yesOrder?: OrderResponse,
    noOrder?: OrderResponse
  ): Promise<Awaited<ReturnType<ExecutionFailureRecovery['handleFailure']>>> {
    const opportunity = this.deps.opportunity;
    const unfilledLeg = filledLeg === 'yes' ? 'no' : 'yes';
    const unfilledOrder = filledLeg === 'yes' ? noOrder : yesOrder;
    const unfilledTokenId = filledLeg === 'yes' ? opportunity.noTokenId : opportunity.yesTokenId;
    const entryPrice = filledLeg === 'yes' ? opportunity.yesPrice : opportunity.noPrice;
    const tokenId = filledLeg === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;

    let state = this.deps.transition(
      current,
      filledLeg === 'yes' ? { type: 'FILL_YES', atMs } : { type: 'FILL_NO', atMs }
    );
    state = this.deps.transition(state, { type: 'PARTIAL_FILL', atMs });

    const cancelResult = await this.cancelLeg(unfilledLeg, unfilledOrder, unfilledTokenId);
    if (!cancelResult.ok) {
      this.deps.incidentTracker?.record({
        marketId: opportunity.marketId,
        reason: 'order_cancel_failed',
        timestamp: atMs,
        opportunityId: opportunity.id,
        detail: { cancel: cancelResult, filledLeg, unfilledLeg }
      });
    }

    this.deps.markIdempotencyFailed(this.deps.yesIdempotencyKey, atMs);
    this.deps.markIdempotencyFailed(this.deps.noIdempotencyKey, atMs);

    const tickSize = this.deps.resolveUnwindTickSize(filledLeg, opportunity, this.deps.context);
    this.deps.incidentTracker?.record({
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
    this.deps.incidentTracker?.record({
      marketId: opportunity.marketId,
      reason: 'unwind_triggered',
      timestamp: atMs,
      opportunityId: opportunity.id,
      detail: { filledLeg, entryPrice, tickSize, filledSize }
    });

    const unwind = await this.handleUnwind(state, filledLeg, entryPrice, tickSize, filledSize);
    state = unwind.state;

    if (!unwind.result.ok) {
      this.deps.incidentTracker?.record({
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
        kind: 'paired',
        status: 'failed',
        reason: 'unwind_failed',
        yesOrder,
        noOrder,
        idempotencyKey: this.deps.idempotencyKey,
        executionId: this.deps.executionId,
        state: state.state
      };
    }

    this.deps.recordUnwindPortfolio(opportunity.marketId, tokenId, entryPrice, unwind.result.price, filledSize);
    return {
      kind: 'paired',
      status: 'failed',
      reason: 'partial_fill',
      yesOrder,
      noOrder,
      idempotencyKey: this.deps.idempotencyKey,
      executionId: this.deps.executionId,
      state: state.state
    };
  }

  private resolvePartialFillLeg(yesOrder?: OrderResponse, noOrder?: OrderResponse): 'yes' | 'no' | null {
    const yesOk = this.deps.isOrderSuccessful(yesOrder);
    const noOk = this.deps.isOrderSuccessful(noOrder);
    if (yesOk && !noOk) return 'yes';
    if (noOk && !yesOk) return 'no';
    return null;
  }

  private async handleUnwind(
    current: PairedExecutionState,
    filledLeg: 'yes' | 'no',
    entryPrice: number,
    tickSize: number,
    unwindSize: number
  ): Promise<{ state: PairedExecutionState; result: UnwindResult }> {
    const opportunity = this.deps.opportunity;
    const tokenId = filledLeg === 'yes' ? opportunity.yesTokenId : opportunity.noTokenId;
    const unwindPrice = this.deps.calculateUnwindPrice(entryPrice, tickSize, {
      marketId: opportunity.marketId,
      opportunityId: opportunity.id
    });
    const clientOrderId = `${this.deps.idempotencyKey}:${filledLeg}:unwind`;
    const unwindOrder = buildFakSellOrder({
      tokenId,
      size: unwindSize,
      price: unwindPrice,
      clientOrderId
    });

    let state = this.deps.transition(current, { type: 'START_UNWIND', atMs: Date.now() });
    try {
      const response = await this.deps.withTimeout(
        this.deps.clob.createOrder(toClobOrderPayload(unwindOrder)),
        this.deps.timeouts.submitTimeoutMs,
        `unwind_${filledLeg}`
      );
      const order = coerceOrderResponse(response);
      const ok = this.deps.isOrderSuccessful(order);
      const finishMs = Date.now();
      if (!ok) {
        state = this.deps.transition(state, { type: 'FAILED', atMs: finishMs, reason: 'unwind_failed' });
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
      state = this.deps.transition(state, { type: 'UNWIND_COMPLETE', atMs: finishMs });
      state = this.deps.transition(state, { type: 'COMPLETE', atMs: finishMs });
      return { state, result: { ok: true, leg: filledLeg, price: unwindPrice, size: unwindSize, order } };
    } catch (error) {
      const finishMs = Date.now();
      state = this.deps.transition(state, { type: 'FAILED', atMs: finishMs, reason: 'unwind_failed' });
      return {
        state,
        result: {
          ok: false,
          leg: filledLeg,
          price: unwindPrice,
          size: unwindSize,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private cancelLeg(
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
  }> {
    const orderId = this.deps.extractOrderId(order);
    const scope: 'order' | 'market' = orderId ? 'order' : 'market';
    const request = orderId
      ? this.deps.withTimeout(this.deps.clob.cancelOrder(orderId), this.deps.timeouts.cancelTimeoutMs, `cancel_${leg}`)
      : this.deps.withTimeout(
          this.deps.clob.cancelMarketOrders({ assetId: tokenId }),
          this.deps.timeouts.cancelTimeoutMs,
          `cancel_${leg}`
        );

    return request
      .then((response) => ({
        ok: !this.deps.isCancelFailure(response, orderId),
        leg,
        scope,
        orderId,
        response
      }))
      .catch((error: unknown) => ({
        ok: false,
        leg,
        scope,
        orderId,
        error: this.deps.formatCancelError(error)
      }));
  }
}
