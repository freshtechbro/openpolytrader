# Ops Agent

## Scope
Applies to `src/agents/ops/`.

## Responsibilities
- Run SLO checks and emit health/incident telemetry.
- Provide ops summaries and metrics to the API layer.

## Rules
- Keep SLO checks pure and deterministic.
- Record incidents with enough context to debug quickly.
- Maintain backward-compatible event payloads.

## Tests
- `npm run test -- tests/unit/ops-agent-extra.test.ts`
- `npm run test -- tests/unit/ops-agent-scheduling.test.ts`
- `npm run test -- tests/unit/ops-agent-llm-summary.test.ts`
- `npm run test -- tests/unit/slo-aggregates.test.ts`
