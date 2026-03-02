# IP Oracle Client

## Scope
Applies to `src/services/ip-oracle/`.

## Responsibilities
- Backend client integration with oracle sidecar health/projection endpoints.

## Rules
- Treat oracle connectivity as a strict runtime dependency in paper/live workflows.
- Keep request timeouts and retry behavior explicit and bounded.
- Surface failures with actionable, typed error context.

## Tests
- `npm run test -- tests/integration/ip-oracle-sidecar-smoke.test.ts`
- `npm run test -- tests/unit/fw-projection-agent.test.ts`
