import type {
  ExpectedFill,
  ObservedFill
} from '../../domain/portfolio.js';

export type ExpectedFillResolution =
  | { expected: ExpectedFill; key: string; ambiguous?: undefined }
  | { expected: ExpectedFill; key: string; ambiguous: number }
  | null;

export function expectedFillKey(opportunityId: string, tokenId: string): string {
  return `${opportunityId}:${tokenId}`;
}

export function actualToDetail(actual: ObservedFill): Record<string, unknown> {
  return {
    tokenId: actual.tokenId,
    marketId: actual.marketId,
    opportunityId: actual.opportunityId,
    side: actual.side,
    size: actual.size,
    price: actual.price,
    timestamp: actual.timestamp
  };
}

export function expectedToDetail(expected: ExpectedFill): Record<string, unknown> {
  return {
    opportunityId: expected.opportunityId,
    tokenId: expected.tokenId,
    expectedSize: expected.expectedSize,
    expectedPrice: expected.expectedPrice,
    timestamp: expected.timestamp
  };
}

export function isPriceWithinTolerance(
  expected: ExpectedFill,
  actual: ObservedFill,
  tolerance: number
): boolean {
  const expectedPrice = expected.expectedPrice;
  if (!Number.isFinite(expectedPrice) || !Number.isFinite(actual.price)) return false;

  if (actual.side === 'BUY') {
    return actual.price <= expectedPrice + tolerance;
  }

  return actual.price >= expectedPrice - tolerance;
}

export function resolveExpectedFillCandidates(
  expectedFills: Iterable<[string, ExpectedFill]>,
  actual: ObservedFill
): Array<{ key: string; expected: ExpectedFill }> {
  const candidates: Array<{ key: string; expected: ExpectedFill }> = [];
  for (const [key, expected] of expectedFills) {
    if (isSameExpectedFillCandidate(expected, actual)) {
      candidates.push({ key, expected });
    }
  }
  return candidates;
}

function isSameExpectedFillCandidate(expected: ExpectedFill, actual: ObservedFill): boolean {
  if (expected.tokenId !== actual.tokenId) return false;
  if (actual.opportunityId && expected.opportunityId !== actual.opportunityId) return false;
  return true;
}
