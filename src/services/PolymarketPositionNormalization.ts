import type { VenuePosition } from '../domain/venue.js';

function asPayload(raw: unknown): Record<string, unknown> {
  return raw as Record<string, unknown>;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractPositionTokenId(payload: Record<string, unknown>): string {
  return pickString(payload.asset, payload.asset_id, payload.assetId);
}

function extractPositionMarketId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.conditionId === 'string' ? payload.conditionId : undefined;
}

export function normalizeVenuePosition(raw: unknown): VenuePosition | null {
  const payload = asPayload(raw);
  const tokenId = extractPositionTokenId(payload);
  if (!tokenId) {
    return null;
  }

  return {
    tokenId,
    marketId: extractPositionMarketId(payload),
    size: parseFiniteNumber(payload.size) ?? 0,
    avgPrice: parseFiniteNumber(payload.avgPrice) ?? undefined,
    currentPrice: parseFiniteNumber(payload.curPrice) ?? undefined,
    raw
  };
}
