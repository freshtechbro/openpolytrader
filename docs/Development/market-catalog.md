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

## Auto-generating the catalog (Polymarket)

You can generate a catalog automatically from the Polymarket CLOB `GET /markets` endpoint.

The generator filters to **active**, **accepting orders**, **not closed/archived**, **binary (2-token)** markets where `enable_order_book=true`.

In `near-zero` mode it also verifies **both** orderbooks exist and have non-empty asks, and requires `tick_size` + `min_order_size` from `/book` (to avoid runtime fallback metadata for near-zero policy).

Generate a catalog file:
```bash
# Dev (no build needed)
npx tsx src/tools/marketCatalogGeneratorCli.ts --out data/market-catalog.json --mode near-zero --verify-books --require-metadata --overwrite

# Prod / Docker (after build)
npm run build
node dist/tools/marketCatalogGeneratorCli.js --out data/market-catalog.json --mode near-zero --verify-books --require-metadata --overwrite
```

Optional filters:
```bash
# Stop after N pairs
node dist/tools/marketCatalogGeneratorCli.js --out data/market-catalog.json --max 200

# Only include markets with tags matching a substring
node dist/tools/marketCatalogGeneratorCli.js --out data/market-catalog.json --tag politics

# Conservative mode: only outcomes exactly Yes/No
node dist/tools/marketCatalogGeneratorCli.js --out data/market-catalog.json --yesno-only
```

Then point the runtime at the generated file:
```bash
MARKET_CATALOG_PATH=data/market-catalog.json
```

## Automated refresh (deploy prestart)

When starting via `npm start` (including the Docker image), a prestart hook runs a conservative catalog refresh:
- Uses `MARKET_CATALOG_PATH` as the output path
- Uses `near-zero` mode
- Uses `--yesno-only` (only outcomes exactly Yes/No)
- Uses merge semantics (never removes existing pairs)
- Preserves existing pair count by default in merge mode

If the file does not exist yet, it bootstraps up to `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS` near-zero-compatible pairs (default: 80).

Refresher tuning (env-only):
- `MARKET_CATALOG_MIN_VOLUME_24H` (default: 1000) sets the minimum 24h volume.
- `MARKET_CATALOG_ORDER` (default: `volume24hr`) accepts `volume24hr` or `newest` (maps to Gamma `order=id`).
- `MARKET_CATALOG_PAGE_SIZE` (default: 100) and `MARKET_CATALOG_MAX_PAGES` (default: 5) bound pagination.

Manual refresh that never removes existing pairs:
```bash
npm run build
npm run catalog:refresh -- --out data/market-catalog.json
```

Manual refresh that can *add* new near-zero-compatible pairs while preserving existing ones:
```bash
npm run build
npm run catalog:refresh -- --out data/market-catalog.json --max 300
```

Notes:
- `data/market-catalog.json` is gitignored by default (generated artifact).
- This is an allowlist seed mechanism; for production, prefer reviewing the generated catalog and trimming it to the markets you actually want to trade.

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
