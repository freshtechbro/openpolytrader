# Ops API

## Scope
Applies to `src/api/`.

## Responsibilities
- Expose ops endpoints for health, metrics, config, and SSE stream.
- Keep API behavior consistent with dashboard expectations.

## Rules
- Validate request payloads with schema helpers.
- Return typed error payloads and status codes.

## Tests
- `npm run test -- tests/unit/api-config.test.ts`
- `npm run test -- tests/unit/api-config-missing-schema.test.ts`
- `npm run test -- tests/unit/server-routes-direct.test.ts`
- `npm run test -- tests/unit/server-session-direct.test.ts`
