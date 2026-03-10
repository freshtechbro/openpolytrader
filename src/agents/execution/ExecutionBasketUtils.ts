import { isDelayedOrderResponse, isOrderFailure } from '../../domain/execution.js';
import { fwOpportunityId, type ArbitrageOpportunity } from '../../domain/opportunity.js';

export function createBasketLegOpportunity(
  basketOpportunity: ArbitrageOpportunity,
  leg: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'][number],
  nowMs: number
): ArbitrageOpportunity {
  return {
    id: fwOpportunityId(leg.marketId, leg.projectedEdge, leg.edgeLowerBound, nowMs),
    marketId: leg.marketId,
    yesTokenId: leg.yesTokenId,
    noTokenId: leg.noTokenId,
    yesPrice: leg.yesPrice,
    noPrice: leg.noPrice,
    costPerSet: leg.costPerSet,
    edge: leg.edgeLowerBound,
    tickSize: leg.tickSize,
    maxSizeByDepth: leg.maxSizeByDepth,
    minOrderSize: leg.minOrderSize,
    detectedAt: basketOpportunity.detectedAt,
    gateReasons: [],
    pair: {
      marketId: leg.marketId,
      yesTokenId: leg.yesTokenId,
      noTokenId: leg.noTokenId
    },
    type: 'fw_projection',
    fw: basketOpportunity.fw
  };
}

export function parseBatchOutcome(
  response: unknown,
  expectedOrders: number
): {
  outcome: 'submitted' | 'partial' | 'fallback';
  acceptedIndices: number[];
  candidateOrders?: unknown[];
} {
  const arrayPayload = Array.isArray(response) ? response : null;
  const objectPayload = response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const candidateOrders =
    arrayPayload ??
    (Array.isArray(objectPayload?.orders)
      ? (objectPayload.orders as unknown[])
      : Array.isArray(objectPayload?.results)
        ? (objectPayload.results as unknown[])
        : null);
  if (candidateOrders) {
    const acceptedIndices: number[] = [];
    for (let index = 0; index < candidateOrders.length; index += 1) {
      const order = candidateOrders[index];
      if (!isOrderFailure(order) && !isDelayedOrderResponse(order)) acceptedIndices.push(index);
    }
    const accepted = acceptedIndices.length;
    if (accepted >= expectedOrders && expectedOrders > 0) {
      return { outcome: 'submitted', acceptedIndices, candidateOrders };
    }
    if (accepted > 0) return { outcome: 'partial', acceptedIndices, candidateOrders };
    return { outcome: 'fallback', acceptedIndices: [], candidateOrders };
  }

  const acceptedCountRaw = objectPayload?.acceptedCount ?? objectPayload?.accepted;
  const acceptedCount =
    typeof acceptedCountRaw === 'number' && Number.isFinite(acceptedCountRaw) ? acceptedCountRaw : undefined;
  if (acceptedCount !== undefined) {
    const bounded = Math.max(0, Math.min(expectedOrders, Math.floor(acceptedCount)));
    const acceptedIndices = Array.from({ length: bounded }, (_unused, index) => index);
    if (acceptedCount >= expectedOrders && expectedOrders > 0) return { outcome: 'submitted', acceptedIndices };
    if (acceptedCount > 0) return { outcome: 'partial', acceptedIndices };
    return { outcome: 'fallback', acceptedIndices: [] };
  }

  return objectPayload?.success === true
    ? { outcome: 'partial', acceptedIndices: [] }
    : { outcome: 'fallback', acceptedIndices: [] };
}
