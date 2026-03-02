# FW Projection Agent

## Scope
Applies to `src/agents/projection/`.

## Responsibilities
- Run fully-corrective Frank-Wolfe projection loop and emit FW opportunities.
- Enforce projection eligibility and basket-shaping constraints before risk handoff.

## Rules
- Keep FW loop bounded by configured runtime/iteration tolerances.
- Ensure emitted opportunities remain executable under downstream gate semantics.
- Preserve deterministic telemetry for `fw_iteration`, `fw_gap`, and `fw_basket` events.

## Tests
- `npm run test -- tests/unit/fw-projection-agent.test.ts`
- `npm run test -- tests/unit/fw-loop-engine.test.ts`
- `npm run test -- tests/unit/gates.test.ts`
