import type { TradePolicy } from '../../config/policy.js';
import type { BasketExecutionLegState, ExecutionState } from '../../domain/execution.js';
import type { IncidentRecord } from '../../domain/incident.js';
import type { IdempotencyRecord } from '../../domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { OrderResponse } from '../../domain/types.js';
import type { MetricEvent } from '../../telemetry/metrics.js';
import type { ExecutionAdvisor } from './ExecutionAdvisor.js';
import type { UserFillOutcome } from './ExecutionOrderTracker.js';

export interface ExecutionContext {
  yesBook?: OrderBookState;
  noBook?: OrderBookState;
  nowMs?: number;
}

export interface ExecutionTimeouts {
  submitTimeoutMs: number;
  ackTimeoutMs: number;
  fillTimeoutMs: number;
  cancelTimeoutMs: number;
}

type ExecutionAttemptStatus = 'submitted' | 'failed' | 'blocked';
type ExecutionAttemptKind = 'paired' | 'ev' | 'basket';
type PreflightExecutionKind = Exclude<ExecutionAttemptKind, 'basket'>;

interface ExecutionAttemptBase {
  kind: ExecutionAttemptKind;
  status: ExecutionAttemptStatus;
  reason?: string;
  idempotencyKey: string;
  executionId: string;
  state: ExecutionState;
}

export interface ExecutionPairedAttemptResult extends ExecutionAttemptBase {
  kind: 'paired';
  yesOrder?: OrderResponse;
  noOrder?: OrderResponse;
}

export interface ExecutionEvAttemptResult extends ExecutionAttemptBase {
  kind: 'ev';
  side?: 'yes' | 'no';
  order?: OrderResponse;
}

export interface ExecutionBasketAttemptResult extends ExecutionAttemptBase {
  kind: 'basket';
  basket?: {
    mode: 'batch_best_effort' | 'sequential_failfast';
    fallbackUsed?: boolean;
    legs: BasketExecutionLegState[];
  };
}

export type ExecutionAttemptResult =
  | ExecutionPairedAttemptResult
  | ExecutionEvAttemptResult
  | ExecutionBasketAttemptResult;

export interface ExecutionPreflightBlockedResult {
  kind: PreflightExecutionKind;
  status: 'blocked';
  reason: string;
  idempotencyKey: string;
  executionId: string;
  state: ExecutionState;
}

export type ExecutionPreflightEffect =
  | { type: 'metric'; event: MetricEvent }
  | { type: 'incident'; incident: IncidentRecord };

export interface ExecutionAcceptedOrder {
  marketId: string;
  side: 'yes' | 'no';
  idempotencyKey: string;
  orderId: string;
}

export interface ExecutionEvParams {
  nowMs: number;
  idempotencyKey: string;
  executionId: string;
  idleState: ExecutionState;
  timeouts: Pick<ExecutionTimeouts, 'submitTimeoutMs' | 'fillTimeoutMs'>;
  record: IdempotencyRecord;
  trackedOrderIds: string[];
}

export interface ExecutionPreflightDecision {
  requiresUserChannel: boolean;
  plannedOrders: number;
  blocked?: ExecutionPreflightBlockedResult;
  effects: ExecutionPreflightEffect[];
}

export interface ExecutionBatchFillObservation {
  allFilled: boolean;
  outcomes: Array<{
    order: ExecutionAcceptedOrder;
    outcome: UserFillOutcome;
  }>;
  observedAtMs: number;
}

export interface ExecutionIdempotencyServices {
  ensureRecord(key: string, nowMs: number): IdempotencyRecord;
  getRecord(key: string): IdempotencyRecord | undefined;
  saveRecord(record: IdempotencyRecord): void;
  markFailed(key: string, nowMs: number): void;
}

export interface ExecutionFillServices {
  waitForFillOutcome(
    orderId: string,
    desiredSize: number,
    timeoutMs: number
  ): Promise<UserFillOutcome>;
  waitForBatchFillOutcomes(
    acceptedOrders: ExecutionAcceptedOrder[],
    size: number,
    timeoutMs: number
  ): Promise<ExecutionBatchFillObservation>;
  cancelOutstandingBatchOrders(
    outcomes: ExecutionBatchFillObservation['outcomes'],
    opportunityId: string,
    nowMs: number
  ): Promise<void>;
}

export interface ExecutionUnwindServices {
  unwindBasketLegs(
    basketOpportunity: ArbitrageOpportunity,
    legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
    size: number,
    nowMs: number
  ): Promise<void>;
  calculateUnwindPrice(
    entryPrice: number,
    tickSize: number,
    advisory?: { marketId: string; opportunityId: string; nowMs?: number }
  ): number;
}

export interface ExecutionRuntimeServices {
  getPolicy(): TradePolicy;
  getTimeouts(): ExecutionTimeouts;
  getExecutionAdvisor(): ExecutionAdvisor | undefined;
  getExecutionAdvisorMode(): 'disabled' | 'shadow' | 'advisory';
}

export interface PairedExecutionService {
  execute(
    opportunity: ArbitrageOpportunity,
    size: number,
    context?: ExecutionContext
  ): Promise<ExecutionPairedAttemptResult>;
}

export interface ExecutionPreflightMetrics {
  getOrderStats(
    marketId: string,
    windowMs: number,
    nowMs: number
  ): {
    orders: number;
    fills: number;
  };
  getOrderVelocity(windowMs: number, nowMs: number): number;
  getDelayedAckRate(marketId: string, windowMs: number, nowMs: number): number;
}

export interface ExecutionUserChannel {
  isConnected(): boolean;
}
