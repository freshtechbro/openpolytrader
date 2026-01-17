# Agents

## Scope
Applies to `src/agents/` and all agent subdirectories.

## Responsibilities
- Implement scanner, risk, execution, portfolio, ops, market-data, and learning agents.
- Emit and consume MessageBus events to move opportunities through the trading pipeline.
- Keep agent decisions deterministic unless explicitly in LLM advisory/active modes.

## Rules
- Read the root `AGENTS.md` and the nearest local `AGENTS.md` before changes.
- Do not bypass risk gates or execution safety checks.
- Maintain event emission contracts (`opportunity:detected`, `risk:approved`, `execution:outcome`, `execution:fill`).
- Avoid `as any` or unsafe casts; prefer explicit types and guards.

## Tests
- Use targeted tests under `tests/unit/*agent*` when changing agent behavior.
- Run full `npm run test:coverage` when touching multiple agents.
