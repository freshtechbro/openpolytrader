# Market Catalog

## Purpose
The market catalog defines the approved market pairs used to seed the trading allowlist. Only markets in this catalog are eligible for scanning and execution. Quarantines can temporarily override this allowlist after incidents.

## Sources and Precedence
Market pairs are loaded from two sources:
1. `src/config/markets.ts` (committed, curated defaults)
2. JSON file at `MARKET_CATALOG_PATH` (local overrides or extensions)

The loader merges the lists and deduplicates by `marketId`. When duplicates exist, the entry from `src/config/markets.ts` wins because it is loaded first.

## JSON Format
`MARKET_CATALOG_PATH` must point to a JSON array of objects with the following schema:

- `marketId` (string, required)
- `yesTokenId` (string, required)
- `noTokenId` (string, required)
- `category` (string, optional)

Example:
```json
[
  {
    "marketId": "0x9b1c...",
    "yesTokenId": "123456",
    "noTokenId": "789012",
    "category": "politics"
  }
]
```

## Identifier Guidance
- `marketId` is the market or condition identifier used for allowlisting and incident tracking.
- `yesTokenId` and `noTokenId` are the token identifiers used for `/book?token_id=...` and order placement.
- Use Polymarket CLOB metadata or SDK tooling to map markets to token IDs. Keep them as strings.

## WS Schema Reference
Real-time orderbook payloads are documented in `@polymarket/real-time-data-client` under `clob_market` / `agg_orderbook`.
Key fields include:
- `asset_id` for the token identifier
- `bids` and `asks` arrays with `price` and `size`
- `market`, `min_order_size`, and `tick_size`

For the CLOB subscriptions endpoint (`wss://ws-subscriptions-clob.polymarket.com/ws/market`), subscribe with:
```json
{ "type": "market", "assets_ids": ["<tokenId>"] }
```

## Boot Flow
1. `MarketCatalog` loads pairs from config and the optional JSON file.
2. `main.ts` seeds the `MarketAllowlist` with `marketId` values.
3. The Ops dashboard and `/metrics` endpoint report the seeded count.

If no pairs are loaded, the allowlist is empty and no trades are permitted.

## Operational Notes
- Invalid JSON or non-array payloads are ignored by the loader; validate the file before startup.
- Incident tracking can quarantine a market even if it is in the catalog. The allowlist table in the dashboard reflects quarantines and expiry.

## UI Reference
The Ops dashboard includes an allowlist panel showing seeded markets and their current status. Use this panel to verify the catalog load and quarantine state.
