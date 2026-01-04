export function parseExchangeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  return Number.isFinite(asDate) ? asDate : null;
}

export function isOutOfSequence(prevTimestamp: unknown, nextTimestamp: unknown): boolean {
  const prev = parseExchangeTimestamp(prevTimestamp);
  const next = parseExchangeTimestamp(nextTimestamp);
  if (prev === null || next === null) return false;
  return next < prev;
}
