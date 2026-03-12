# Services

## Scope
Applies to `src/services/` (excluding `src/services/llm/`).

## Responsibilities
- External API clients (Polymarket CLOB/WS/Data API), market-catalog helpers, and shared transport utilities.
- Enforce retries, rate limiting, and auth requirements.

## Rules
- Do not leak secrets in logs or telemetry.
- Keep timeouts and retry policies centralized.
- Return typed responses; avoid `any`.

## Tests
- `npm run test -- tests/unit/market-catalog.test.ts`
- `npm run test -- tests/unit/market-catalog-generator.test.ts`
- `npm run test -- tests/unit/market-catalog-refresher.test.ts`
- `npm run test -- tests/unit/incident-tracker.test.ts`
- `npm run test -- tests/unit/polygon-rpc.test.ts`
- `npm run test -- tests/unit/polymarket-clob.test.ts`
- `npm run test -- tests/unit/polymarket-data-api.test.ts`
- `npm run test -- tests/unit/polymarket-realtime.test.ts`
- `npm run test -- tests/unit/polymarket-auth.test.ts`
- `npm run test -- tests/unit/polymarket-api-creds.test.ts`
- `npm run test -- tests/unit/retry-policy.test.ts`
- `npm run test -- tests/unit/rate-limiter.test.ts`
