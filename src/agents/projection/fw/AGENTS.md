# FW Math Engine

## Scope
Applies to `src/agents/projection/fw/`.

## Responsibilities
- Core FW objective, simplex, hull solve, and loop-engine math primitives.

## Rules
- Keep numerical updates deterministic and bounded.
- Avoid hidden side effects; functions should remain pure where possible.
- Preserve convergence diagnostics used by projection telemetry.

## Tests
- `npm run test -- tests/unit/fw-loop-engine.test.ts`
- `npm run test -- tests/unit/fw-hull-solver.test.ts`
- `npm run test -- tests/unit/fw-objective.test.ts`
