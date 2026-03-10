import type { GammaMarket } from './MarketCatalogTypes.js';

export function extractConditionId(market: GammaMarket): string | null {
  const value = market.condition_id ?? market.conditionId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function isMarketEnded(market: GammaMarket, nowMs: number): boolean {
  const endMs = extractMarketEndTimeMs(market);
  return endMs !== null && endMs <= nowMs;
}

export function extractTokenIds(market: GammaMarket): { yesTokenId: string; noTokenId: string } | null {
  const parsedIds = parseClobTokenIds(market.clobTokenIds);
  if (parsedIds && parsedIds.length === 2) {
    return { yesTokenId: parsedIds[0], noTokenId: parsedIds[1] };
  }

  if (!Array.isArray(market.tokens) || market.tokens.length !== 2) return null;

  const [a, b] = market.tokens;
  const aToken = a?.token_id ?? a?.tokenId;
  const bToken = b?.token_id ?? b?.tokenId;
  if (!aToken || !bToken) return null;

  const aOutcome = (a.outcome ?? '').toLowerCase().trim();
  const bOutcome = (b.outcome ?? '').toLowerCase().trim();

  if (aOutcome === 'yes' && bOutcome === 'no') {
    return { yesTokenId: aToken, noTokenId: bToken };
  }
  if (aOutcome === 'no' && bOutcome === 'yes') {
    return { yesTokenId: bToken, noTokenId: aToken };
  }

  const sorted = [
    { tokenId: aToken, outcome: aOutcome },
    { tokenId: bToken, outcome: bOutcome }
  ].sort((x, y) => x.tokenId.localeCompare(y.tokenId));
  return { yesTokenId: sorted[0].tokenId, noTokenId: sorted[1].tokenId };
}

function parseClobTokenIds(value: GammaMarket['clobTokenIds']): string[] | null {
  if (Array.isArray(value)) {
    return value.every((id) => typeof id === 'string') ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractMarketEndTimeMs(market: GammaMarket): number | null {
  const candidates: Array<unknown> = [market.endDate, market.endDateIso, market.end_date, market.end_date_iso];
  for (const value of candidates) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
