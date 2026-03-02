# Agents

## Scope
Applies to `src/agents/` and all agent subdirectories.

## Responsibilities
- Implement scanner, risk, execution, portfolio, ops, market-data, and learning agents.
- Emit and consume MessageBus events to move opportunities through the trading pipeline.
- Keep agent decisions deterministic unless explicitly in LLM advisory/active modes.

## Strategy Characteristics

- `near_zero`: paired YES/NO arbitrage with strict two-leg safety and gate discipline.
- `ev`: single-sided directional execution path with confidence thresholds, cooldown, and EV notional caps.
- `fw_projection`: dependency-aware Frank-Wolfe projection path; non-converged/non-feasible candidates are rejected.
- `fw_basket`: multi-market FW basket execution with bounded basket size and mode (`sequential_failfast` or `batch_best_effort`).

## Rules
- Read the root `AGENTS.md` and the nearest local `AGENTS.md` before changes.
- Do not bypass risk gates or execution safety checks.
- Maintain event emission contracts (`opportunity:detected`, `risk:approved`, `execution:outcome`, `execution:fill`).
- Avoid `as any` or unsafe casts; prefer explicit types and guards.

## Tests
- Use targeted tests under `tests/unit/*agent*` when changing agent behavior.
- Run full `npm run test:coverage` when touching multiple agents.
