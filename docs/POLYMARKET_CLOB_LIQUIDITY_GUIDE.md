# Polymarket CLOB: Liquidity, Market Depth & Execution Best Practices

**Last Updated:** 2026-01-01  
**Sources:** Official Polymarket Documentation & API Reference

---

## Executive Summary

Polymarket uses a Central Limit Order Book (CLOB) architecture for binary prediction markets. Key execution considerations:

- **No Trading Limits** - Orders of any size accepted, but liquidity depth determines execution
- **Min Order Size:** 0.001 shares (market-specific)
- **Tick Size:** Dynamic - 0.01, 0.001, or 0.0001 (changes at price extremes)
- **Best Execution:** Use limit orders (GTC) + check orderbook depth + monitor bid-ask spread
- **No Fees:** Zero trading fees on Polymarket

---

## 1. Market Depth & Liquidity

### 1.1 Orderbook Structure

**Endpoint:** `GET https://clob.polymarket.com/book?token_id={token_id}`

**Source:** https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary

**Response Fields:**
```json
{
  "bids": [
    { "price": "1800.50", "size": "10.5" }
  ],
  "asks": [
    { "price": "1800.50", "size": "10.5" }
  ],
  "min_order_size": "0.001",
  "tick_size": "0.01",
  "timestamp": "2023-10-01T12:00:00Z",
  "hash": "0xabc123..."
}
```

**Key Points:**
- `bids`: Buy orders sorted by price descending
- `asks`: Sell orders sorted by price ascending  
- `size`: Quantity available at each price level
- `min_order_size`: Minimum order size for this market (typically 0.001)
- `tick_size`: Minimum price increment for this market

### 1.2 No Trading Size Limits

**Source:** https://docs.polymarket.com/polymarket-learn/trading/no-limits

> "By design, Polymarket orderbook does not have trading size limits. It matches willing buyers and sellers of any amount. However, there is no guarantee that it will be possible to transact a desired amount of shares without impacting the price significantly, or at all if there are no willing counterparties."

**Implication:** Before trading large sizes, **check orderbook depth** to understand available liquidity.

### 1.3 Calculating Price Impact

To estimate slippage:

1. Get full orderbook via `/book` endpoint
2. Sum sizes from best price outward until you reach your trade size
3. Weighted average price = Σ(price × size) / Σsize
4. Slippage = weighted_avg_price - best_price

---

## 2. Tick Size & Order Constraints

### 2.1 Dynamic Tick Sizes

**Source:** https://docs.polymarket.com/developers/CLOB/websocket/market-channel

> "Emitted When: The minimum tick size of the market changes. This happens when the book's price reaches the limits: price > 0.96 or price < 0.04"

**Tick Size Change WebSocket Message:**
```json
{
  "event_type": "tick_size_change",
  "old_tick_size": "0.01",
  "new_tick_size": "0.001",
  "timestamp": "100000000"
}
```

### 2.2 Supported Tick Sizes

**Source:** https://docs.polymarket.com/developers/market-makers/trading

```javascript
const tickSize = TickSize(tokenID); 
// Returns: "0.1" | "0.01" | "0.001" | "0.0001"
```

**Best Practice:** Always fetch current `tick_size` from `/book` response before placing orders.

---

## 3. Best Bid / Ask / Midpoint Endpoints

### 3.1 Get Midpoint Price

**Endpoint:** `GET https://clob.polymarket.com/midpoint?token_id={token_id}`

**Source:** https://docs.polymarket.com/api-reference/pricing/get-midpoint-price

**Response:**
```json
{ "mid": "1800.75" }
```

**Note:** Midpoint = (best_bid + best_ask) / 2

### 3.2 Get Multiple Market Prices

**Endpoint:** `POST https://clob.polymarket.com/prices`

**Source:** https://docs.polymarket.com/api-reference/pricing/get-multiple-market-prices-by-request

**Request:**
```json
[
  { "token_id": "1234567890", "side": "BUY" },
  { "token_id": "0987654321", "side": "SELL" }
]
```

**Response:**
```json
{
  "1234567890": { "BUY": "1800.50", "SELL": "1801.00" },
  "0987654321": { "BUY": "50.25", "SELL": "50.30" }
}
```

### 3.3 Best Bid/Ask via WebSocket

**Source:** https://docs.polymarket.com/developers/CLOB/websocket/market-channel

**Message Type:** `best_bid_ask` (behind `custom_feature_enabled` flag)

```json
{
  "event_type": "best_bid_ask",
  "best_bid": "0.73",
  "best_ask": "0.77",
  "spread": "0.04",
  "timestamp": "1766789469958"
}
```

---

## 4. Order Types & Execution Behavior

### 4.1 Supported Order Types

**Source:** https://docs.polymarket.com/developers/CLOB/orders/create-order

| Type | Name | Behavior | Use Case |
|------|------|----------|-----------|
| **FOK** | Fill-Or-Kill | Must fill entirely immediately or cancelled | All-or-nothing execution |
| **FAK** | Fill-And-Kill | Fill available, cancel remainder | Accept partial fills |
| **GTC** | Good-Til-Cancelled | Rests on book until filled/cancelled | Passive limit orders |
| **GTD** | Good-Til-Date | Expires at specified UTC timestamp | Time-limited quotes |

### 4.2 FOK for Arbitrage (Recommended)

**For YES/NO Arbitrage Pairs:** Use **FOK** orders.

**Why:** FOK guarantees all-or-nothing **per order** only. It does **not** guarantee two-leg atomicity, so one leg can fill while the other fails. Mitigate this with strict gating (depth + stability), batch placement where possible, and a hard fail on any delayed matching signals.

**Error Handling:**
- `FOK_ORDER_NOT_FILLED_ERROR`: Insufficient liquidity for full execution
- `ORDER_DELAYED` / `status=delayed`: Matching delay detected (treat as no-trade)
- **Action:** Reduce order size or skip this opportunity

### 4.3 Market Maker Best Practices

**Source:** https://docs.polymarket.com/developers/market-makers/trading

- **Default for Passive Quoting:** GTC (Good-Til-Cancelled)
- **Rebalancing with All-or-Nothing:** FOK
- **Rebalancing with Partial Acceptable:** FAK
- **Auto-Expiring Quotes:** GTD (before event resolution)

---

## 5. Slippage Mitigation Strategies

### 5.1 Best Practices from Official Docs

**Source:** https://polymarket.support/fees/

> - **Trade liquid markets:** Markets with high volume have less slippage
> - **Use limit orders:** Limit orders control execution price precisely
> - **Split large orders:** Break large positions into smaller chunks
> - **Check liquidity:** Review order book depth before trading
> - **Monitor slippage tolerance:** Set maximum acceptable slippage

### 5.2 Calculating Available Liquidity

**Algorithm:**

```typescript
function getAvailableLiquidity(book: OrderBook, side: 'bid' | 'ask', maxPrice: number): number {
  const levels = side === 'bid' ? book.bids : book.asks;
  let totalSize = 0;
  
  for (const level of levels) {
    const price = parseFloat(level.price);
    const size = parseFloat(level.size);
    
    // Stop if price exceeds threshold
    if ((side === 'bid' && price < maxPrice) || 
        (side === 'ask' && price > maxPrice)) {
      break;
    }
    
    totalSize += size;
  }
  
  return totalSize;
}
```

### 5.3 Liquidity Screening for Arbitrage

**Criteria for "Extremely Likely" Fills:**

1. **Spread Check:** YES_ask + NO_ask < $0.97 (3%+ buffer)
2. **Depth Check:** Min(YES_ask_size, NO_ask_size) >= desired_trade_size
3. **Spread Threshold:** Bid-ask spread < $0.05 for both sides
4. **Tick Size Check:** Order size ≥ min_order_size, price aligned to tick_size

**Example Calculation:**

```
YES token:
  - Best ask: 0.48 (size: 500 shares)
  - Next ask: 0.49 (size: 200 shares)
  
NO token:
  - Best ask: 0.49 (size: 600 shares)
  - Next ask: 0.50 (size: 300 shares)

Arbitrage check: 0.48 + 0.49 = 0.97 (< $1.00 ✓)
Liquidity check: min(500, 600) = 500 shares ✓

Recommended: Use FOK for up to 500 shares (both sides fill)
```

---

## 6. Price Display & Midpoint Logic

### 6.1 How Prices Are Calculated

**Source:** https://docs.polymarket.com/polymarket-learn/trading/how-are-prices-calculated

> "The prices displayed on Polymarket are midpoint of bid-ask spread in the orderbook — unless that spread is over $0.10, in which case last traded price is used."

**Example from Docs:**
```
Bid: 34¢
Ask: 40¢
Displayed Price: 37% (midpoint)
Spread: 6¢

Note: If spread > 10¢, use last trade price instead
```

### 6.2 Caution: Displayed Price ≠ Available Price

**From Documentation:**
> "You may not be able to buy shares at the displayed probability / price because there is a bid-ask spread."

**Implication:** Always check `asks` array for actual execution prices.

---

## 7. Liquidity Rewards Program

### 7.1 Rewards Methodology

**Source:** https://docs.polymarket.com/developers/rewards/overview

**Goals:**
- Catalyze liquidity across all markets
- Encourage liquidity throughout market's entire lifecycle
- Motivate **passive, balanced quoting tight to market's mid-point**
- Encourage trading activity
- Discourage exploitative behaviors

### 7.2 Scoring Formula

**Key Variables:**
- `v`: Max spread from midpoint (cents)
- `s`: Spread from size-cutoff-adjusted midpoint
- `b`: In-game multiplier
- `c`: Scaling factor (currently 3.0)

**Quadratic Scoring:**
```
Score = S(v, Spread) × Size
where S(v, s) = ((v - s) / v)² × b
```

**Key Insight:** Orders closer to midpoint score higher, encouraging tight spreads.

### 7.3 Two-Sided vs One-Sided

**Equation 4a** (midpoint in [0.10, 0.90]):
- Single-sided liquidity scores at reduced rate (divided by c)
- Encourages balanced books

**Equation 4b** (midpoint in [0, 0.10) or (0.90, 1.0]):
- Requires **two-sided liquidity** to score
- Prevents manipulation at price extremes

---

## 8. WebSocket Market Channel

### 8.1 Orderbook Updates

**Source:** https://docs.polymarket.com/developers/CLOB/websocket/market-channel

**Message Type:** `book`

```json
{
  "event_type": "book",
  "bids": [
    { "price": ".48", "size": "30" },
    { "price": ".49", "size": "20" },
    { "price": ".50", "size": "15" }
  ],
  "asks": [
    { "price": ".52", "size": "25" },
    { "price": ".53", "size": "60" },
    { "price": ".54", "size": "10" }
  ],
  "timestamp": "123456789000",
  "hash": "0x0...."
}
```

**Emitted When:**
- First subscribed to a market
- When a trade affects the book

### 8.2 Price Level Changes

**Message Type:** `price_change`

```json
{
  "price_changes": [
    {
      "asset_id": "...",
      "price": "0.5",
      "size": "200",
      "side": "BUY",
      "best_bid": "0.5",
      "best_ask": "1"
    }
  ]
}
```

**Emitted When:**
- New order placed
- Order cancelled

---

## 9. Best Practices Summary

### 9.1 For Arbitrage Execution

1. **Use FOK Orders** - Guarantees full fills or no fills
2. **Pre-Fetch Orderbooks** - Check depth before placing orders
3. **Spread Buffer** - Require YES_ask + NO_ask ≤ $0.97 (not $0.99)
4. **Depth Check** - Ensure both sides have adequate size
5. **Tick Size Validation** - Align prices to current tick_size
6. **Min Size Check** - Verify order ≥ min_order_size

### 9.2 Liquidity Screening Algorithm

```typescript
interface MarketData {
  yesBook: OrderBook;
  noBook: OrderBook;
  minOrderSize: number;
  tickSize: string;
}

function canExecuteArb(market: MarketData, tradeSize: number): boolean {
  // Get best asks
  const yesAsk = parseFloat(market.yesBook.asks[0].price);
  const noAsk = parseFloat(market.noBook.asks[0].price);
  
  // Spread check (with buffer)
  if (yesAsk + noAsk > 0.97) return false;
  
  // Size check
  const yesSize = parseFloat(market.yesBook.asks[0].size);
  const noSize = parseFloat(market.noBook.asks[0].size);
  if (Math.min(yesSize, noSize) < tradeSize) return false;
  
  // Tick size alignment
  if (!isAlignedToTick(yesAsk, market.tickSize)) return false;
  if (!isAlignedToTick(noAsk, market.tickSize)) return false;
  
  // Min order size
  if (tradeSize < parseFloat(market.minOrderSize)) return false;
  
  return true;
}
```

### 9.3 Market Selection Criteria

**High Liquidity Markets (Preferred):**
- 24-hour volume > $50,000
- Typical spread < $0.02 (2¢)
- Orderbook depth > 1,000 shares at top 3 levels
- Active market makers (frequent tick_size changes)

**Avoid (Low Liquidity):**
- Spread > $0.10
- Orderbook depth < 100 shares
- Single-sided books
- Thin markets (low volume, few participants)

---

## 10. API Rate Limits

**Source:** https://docs.polymarket.com/quickstart/introduction/rate-limits

| Endpoint | Rate Limit |
|----------|------------|
| CLOB general | 9,000 requests / 10s |
| Trading (orders) | 3,500 requests / 10s burst |
| CLOB Market Tick Size | 200 requests / 10s |

**Best Practice:** Use WebSocket for real-time updates, REST for snapshots only.

---

## 11. Error Handling

### 11.1 Common Order Errors

**Source:** https://docs.polymarket.com/developers/CLOB/orders/create-order

| Error | Meaning | Action |
|-------|----------|--------|
| `INVALID_ORDER_MIN_SIZE` | Order < min_order_size | Increase order size |
| `INVALID_ORDER_MIN_TICK_SIZE` | Price not aligned to tick_size | Round to nearest tick |
| `FOK_ORDER_NOT_FILLED_ERROR` | Insufficient liquidity | Reduce size or skip |
| `INSUFFICIENT_BALANCE` | Not enough USDC.e | Check wallet balance |
| `ALLOWANCE_TOO_LOW` | USDC.e not approved | Approve CTF contract |

### 11.2 Retry Logic

```typescript
async function placeWithRetry(order: Order, maxRetries: number = 3): Promise<OrderResult> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await clobClient.postOrder(order, OrderType.FOK);
    } catch (error) {
      if (error.code === 'FOK_ORDER_NOT_FILLED_ERROR') {
        // Liquidity exhausted - don't retry
        throw error;
      }
      if (i === maxRetries - 1) throw error;
      await sleep(100); // 100ms backoff
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## 12. References & URLs

### Official Documentation
- **CLOB Introduction:** https://docs.polymarket.com/developers/CLOB/introduction
- **Orderbook Endpoint:** https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary
- **Midpoint Endpoint:** https://docs.polymarket.com/api-reference/pricing/get-midpoint-price
- **Market Prices:** https://docs.polymarket.com/api-reference/pricing/get-multiple-market-prices-by-request
- **WebSocket Market Channel:** https://docs.polymarket.com/developers/CLOB/websocket/market-channel
- **Order Types:** https://docs.polymarket.com/developers/CLOB/orders/create-order
- **Market Maker Trading:** https://docs.polymarket.com/developers/market-makers/trading
- **Liquidity Rewards:** https://docs.polymarket.com/developers/rewards/overview
- **Price Calculation:** https://docs.polymarket.com/polymarket-learn/trading/how-are-prices-calculated
- **No Trading Limits:** https://docs.polymarket.com/polymarket-learn/trading/no-limits
- **Trading Fees:** https://docs.polymarket.com/polymarket-learn/trading/fees
- **Rate Limits:** https://docs.polymarket.com/quickstart/introduction/rate-limits

### GitHub SDKs
- **Python CLOB Client:** https://github.com/Polymarket/py-clob-client
- **TypeScript CLOB Client:** https://github.com/Polymarket/clob-client
- **Market Maker Bot (Official):** https://github.com/Polymarket/poly-market-maker

---

## Appendix: Quick Reference

| Metric | Value | Source |
|--------|--------|--------|
| Min Order Size | 0.001 shares (typical) | API response |
| Tick Sizes | 0.1, 0.01, 0.001, 0.0001 (dynamic) | Market Maker Docs |
| Price Display | Midpoint (unless spread > $0.10) | Price Calculation |
| Spread Threshold for Midpoint | $0.10 | Price Calculation |
| Fees | 0 | Trading Fees |
| Rate Limit (CLOB) | 9,000 req / 10s | Rate Limits |
| Rate Limit (Trading) | 3,500 req / 10s | Rate Limits |
| Two-sided Score Factor | c = 3.0 | Liquidity Rewards |

---

**Document Version:** 1.0  
**Last Verified:** 2026-01-01
