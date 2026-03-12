export function hasAskLevels(
  book: { asks?: Array<{ price: string | number; size: string | number }> }
): boolean {
  return Array.isArray(book.asks) && book.asks.length > 0;
}

export function spreadWithinLimitOrUnavailable(
  book: {
    bids?: Array<{ price: string | number }>;
    asks?: Array<{ price: string | number }>;
  },
  maxSpread: number
): boolean {
  if (!Array.isArray(book.bids) || book.bids.length === 0) return true;
  if (!Array.isArray(book.asks) || book.asks.length === 0) return true;

  const bestBid = findBestPrice(book.bids, Math.max);
  const bestAsk = findBestPrice(book.asks, Math.min);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return true;

  return bestAsk - bestBid <= maxSpread;
}

function findBestPrice(
  levels: Array<{ price: string | number }>,
  reducer: (a: number, b: number) => number
): number {
  let best: number | null = null;
  for (const level of levels) {
    const price = Number(level.price);
    if (!Number.isFinite(price)) continue;
    best = best === null ? price : reducer(best, price);
  }
  return best ?? Number.NaN;
}
