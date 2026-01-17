# Services

## Scope
Applies to `src/services/` (excluding `src/services/llm/`).

## Responsibilities
- External API clients (Polymarket CLOB/WS/Data API) and helpers.
- Enforce retries, rate limiting, and auth requirements.

## Rules
- Do not leak secrets in logs or telemetry.
- Keep timeouts and retry policies centralized.
- Return typed responses; avoid `any`.

## Tests
- `npm run test -- tests/unit/polymarket-clob.test.ts`
- `npm run test -- tests/unit/polymarket-data-api.test.ts`
- `npm run test -- tests/unit/polymarket-auth.test.ts`
- `npm run test -- tests/unit/polymarket-api-creds.test.ts`
- `npm run test -- tests/unit/retry-policy.test.ts`
- `npm run test -- tests/unit/rate-limiter.test.ts`
