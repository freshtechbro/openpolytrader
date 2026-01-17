# Telemetry

## Scope
Applies to `src/telemetry/`.

## Responsibilities
- Emit metrics and allowlist snapshots.
- Maintain telemetry event type contracts.

## Rules
- Keep event payloads backward compatible.
- Do not emit high-cardinality labels without review.

## Tests
- `npm run test -- tests/unit/telemetry.test.ts`
- `npm run test -- tests/unit/telemetry-events-module.test.ts`
