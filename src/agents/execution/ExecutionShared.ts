import type { CancelOrdersResponse } from '../../services/PolymarketClob.js';
import type { OrderResponse } from '../../domain/types.js';
import { isDelayedOrderResponse, isOrderFailure } from '../../domain/execution.js';

export function applyMultiplier(timeoutMs: number, multiplier: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return timeoutMs;
  const scaled = Math.floor(timeoutMs * multiplier);
  return Math.min(timeoutMs, Math.max(scaled, 1));
}

type TimeoutLikeError = Error & { phase: string; timeoutMs: number };

export function isTimeoutError(error: unknown): error is TimeoutLikeError {
  return (
    error instanceof Error &&
    error.name === 'TimeoutError' &&
    typeof (error as { phase?: unknown }).phase === 'string' &&
    typeof (error as { timeoutMs?: unknown }).timeoutMs === 'number'
  );
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer!: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`timeout:${phase}`), {
          name: 'TimeoutError',
          phase,
          timeoutMs
        })
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function coerceNonceValue(nonce: string): string | number {
  const numeric = Number(nonce);
  return Number.isFinite(numeric) ? numeric : nonce;
}

export function alignPriceUp(price: number, tickSize: number): number {
  return Math.ceil(price / tickSize) * tickSize;
}

export function isOrderSuccessful(order?: OrderResponse): boolean {
  if (!order) return false;
  if (isOrderFailure(order)) return false;
  if (isDelayedOrderResponse(order)) return false;
  return true;
}

export function extractOrderId(order?: OrderResponse): string | undefined {
  if (!order) return undefined;
  const payload = order as OrderResponse & { orderId?: string; order_id?: string };
  return payload.orderID ?? payload.orderId ?? payload.order_id;
}

export function isCancelFailure(
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

export function formatCancelError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'cancel_failed');
}
