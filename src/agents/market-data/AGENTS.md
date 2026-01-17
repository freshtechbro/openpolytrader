# Market Data Agent

## Scope
Applies to `src/agents/market-data/`.

## Responsibilities
- Maintain order book state and market snapshots from WS/REST inputs.
- Emit `market:updated` events for scanner/risk pipelines.

## Rules
- Normalize order book data consistently (tick size, depth, spreads).
- Treat malformed data as incidents; never crash the pipeline.
- Keep derived stats deterministic and replayable.

## Tests
- `npm run test -- tests/unit/orderbook.test.ts`
- `npm run test -- tests/unit/marketdata-llm-request.test.ts`
- `npm run test -- tests/unit/marketdata-llm-outlier.test.ts`
