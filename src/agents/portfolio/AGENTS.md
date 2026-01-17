# Portfolio Agent

## Scope
Applies to `src/agents/portfolio/`.

## Responsibilities
- Track positions, PnL, and reconcile fills against the Polymarket Data API.
- Apply fills/unwinds consistently with execution events.

## Rules
- Keep reconciliation deterministic; do not mutate state outside event flows.
- Ensure portfolio snapshots remain consistent with position updates.
- Treat external API failures as incidents and fail closed.

## Tests
- `npm run test -- tests/unit/portfolio.test.ts`
- `npm run test -- tests/unit/portfolio-llm-anomaly.test.ts`
