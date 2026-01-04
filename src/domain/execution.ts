import type { OrderPlacement, OrderResponse } from './types.js';

export function buildFokBuyOrder(input: {
  tokenId: string;
  size: number;
  price: number;
  clientOrderId: string;
}): OrderPlacement {
  return {
    tokenId: input.tokenId,
    side: 'BUY',
    size: input.size,
    price: input.price,
    orderType: 'FOK',
    clientOrderId: input.clientOrderId
  };
}

export function toClobOrderPayload(order: OrderPlacement): Record<string, unknown> {
  return {
    token_id: order.tokenId,
    side: order.side,
    size: order.size,
    price: order.price,
    order_type: order.orderType,
    client_order_id: order.clientOrderId
  };
}

export function isDelayedOrderResponse(response: unknown): boolean {
  const payload = response as { status?: string; errorMsg?: string; error?: string };
  const status = payload?.status?.toUpperCase();
  return (
    status === 'DELAYED' ||
    payload?.errorMsg === 'ORDER_DELAYED' ||
    payload?.error === 'ORDER_DELAYED'
  );
}

export function isOrderFailure(response: unknown): boolean {
  const payload = response as { success?: boolean; errorMsg?: string; status?: string };
  if (payload?.success === false) return true;
  if (payload?.errorMsg && payload.errorMsg.length > 0) return true;
  return payload?.status === 'rejected';
}

export function coerceOrderResponse(response: unknown): OrderResponse {
  return response as OrderResponse;
}
