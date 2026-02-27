# FWMM Full-Corrective And Basket Execution Spec

Full implementation specification to close the remaining FW gaps in OpenPolyTrader: fully-corrective FW loop (active set, convex re-optimization, gap/contraction) and multi-market basket execution.

---

## Overview

### Scope
- Replace single-shot FW projection behavior with an iterative fully-corrective loop.
- Add FW gap-based convergence/stopping and adaptive contraction controls.
- Extend FW opportunities from single-market outputs to executable multi-market baskets.
- Add end-to-end basket path through scanner, gates, risk, supervisor, and execution.
- Preserve existing `near_zero` and `ev` flows.

### Key decisions (single source of truth)
- Keep CP-SAT sidecar and TypeScript orchestration; extend contracts additively.
- Implement fully-corrective re-optimization over active-set hull in TypeScript (simplex-constrained optimization over active-set weights), not in CP-SAT.
- Use CP-SAT as LMO/oracle each FW iteration (linear objective over dependency constraints).
- Phase 1 basket scope: FW baskets only (not near_zero/EV baskets) to minimize blast radius.
- Prefer additive type extensions and new modules over invasive rewrites.
- Phase 1 basket leg direction is locked to pair-buy only (YES+NO buy legs per selected market).
- FW loop scheduling is locked to global per market-update tick (not per triggering pair).
- Non-converged positive-lower-bound iterates are not tradable in paper mode.
- Basket submission path supports both batch and fallback sequential modes; default is `sequential_failfast`.

### Baseline findings from current code
- Current FW path is one-shot (`src/agents/projection/FwProjectionAgent.ts`).
- Gap returned by sidecar is not used for convergence (`services/ip-oracle/app.py`, `src/services/ip-oracle/IpOracleClient.ts`).
- Execution stack is single-market paired-leg (+ EV single-leg), not basket-capable (`src/agents/execution/ExecutionAgent.ts`, `src/domain/execution.ts`).
- `createBatchOrders` exists but is unused (`src/services/PolymarketClob.ts`).

---

## Task 1 — Add FWMM Runtime Contracts And Policy Surface

### Reasoning
The loop, convergence, and contraction mechanics need explicit config and typed metadata so behavior is deterministic, controllable, and observable in ops.

### What to do
Add FWMM loop policy fields, projection metadata fields, and basket opportunity contracts.

### How
1. Extend `TradePolicy` with FW loop controls:
   - `fwMaxIterations`
   - `fwMaxLoopRuntimeMs`
   - `fwGapAbsTolerance`
   - `fwGapRelTolerance`
   - `fwContractionInitialEpsilon`
   - `fwContractionDecay`
   - `fwContractionMinEpsilon`
   - `fwStallIterationLimit`
   - `fwActiveSetMaxVertices`
   - `fwHullSolveMaxIterations`
   - `fwHullSolveTolerance`
2. Add basket controls:
   - `fwBasketMinMarkets`
   - `fwBasketMaxMarkets`
   - `fwBasketExecutionMode` (`batch_best_effort` | `sequential_failfast`)
3. Extend config schema and validators with range checks and inter-field constraints:
   - enforce `fwBasketMinMarkets <= fwBasketMaxMarkets`,
   - derive Phase 1 max legs as `2 * fwBasketMaxMarkets` (pair-buy-only), rather than adding a separate duplicated knob.
4. Add new opportunity metadata/types in `src/domain/opportunity.ts`:
   - FW loop diagnostics (iteration count, terminal gap, contraction steps, active-set cardinality).
   - Basket payload (selected markets, per-market pair pricing, aggregate lower bound).

### Files impacted
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`
- `src/domain/opportunity.ts`
- `tests/unit/config.test.ts`

### End goal
Policy and types can express full FWMM loop behavior and basket execution intent without breaking existing strategy types.

### Acceptance criteria
- [ ] All new fields have defaults and are exposed through config schema.
- [ ] Validation rejects invalid FW loop/contraction ranges.
- [ ] Validation enforces consistent basket market bounds and derived Phase 1 leg limits.
- [ ] Opportunity typing supports FW basket metadata.
- [ ] Existing near_zero/ev type paths remain type-safe.

---

## Task 2 — Implement FW Objective And Active-Set Math Primitives

### Reasoning
Fully-corrective FW requires reusable primitives for objective/gradient evaluation and convex-combination optimization over an evolving active set.

### What to do
Create dedicated FW math modules for objective evaluation, gradient computation, and simplex-constrained optimization of active-set weights.

### How
1. Add projection math modules under `src/agents/projection/fw/`:
   - `objective.ts`: FW projection objective and gradient.
   - `simplex.ts`: simplex projection utilities.
   - `hullSolver.ts`: projected-gradient (or equivalent) optimizer over active-set weights.
2. Define canonical iterate structures:
   - `FwVertex`, `FwActiveSet`, `FwIterate`, `FwIterationDiagnostics`.
3. Implement numerical safeguards:
   - finite checks,
   - bounded step size,
   - tolerance-based stopping for hull solver,
   - deterministic tie-breakers.
4. Add unit tests for objective monotonicity, gradient correctness sanity checks, and simplex/hull solver convergence behavior.

### Files impacted
- `src/agents/projection/fw/objective.ts` (new file)
- `src/agents/projection/fw/simplex.ts` (new file)
- `src/agents/projection/fw/hullSolver.ts` (new file)
- `tests/unit/fw-hull-solver.test.ts` (new file)
- `tests/unit/fw-objective.test.ts` (new file)

### End goal
FW loop can rely on deterministic and tested numerical primitives for fully-corrective re-optimization over active-set hull.

### Acceptance criteria
- [ ] Hull solver returns valid simplex weights summing to 1 within tolerance.
- [ ] Objective/gradient routines are numerically stable on edge-case inputs.
- [ ] Unit tests verify convergence/stability criteria.

---

## Task 3 — Build Iterative FW Loop Engine (Active Set + Gap + Contraction)

### Reasoning
This is the core missing capability: repeated descent with active-set updates, convex re-optimization, and convergence/stall handling.

### What to do
Implement a dedicated `FwLoopEngine` that executes fully-corrective iterations until gap-based stopping or budget limits.

### How
1. Add `FwLoopEngine` module that orchestrates iterations:
   - initialize feasible interior point `u` and initial vertex,
   - compute gradient at current iterate,
   - call oracle for LMO vertex,
   - compute FW gap,
   - update active set,
   - run hull re-optimization over active-set vertices,
   - apply stopping checks.
2. Implement adaptive contraction logic:
   - when no sufficient descent or repeated stall/timeout,
   - reduce epsilon using configured decay,
   - contract candidate vertex toward interior point,
   - continue or terminate at min epsilon.
3. Track best iterate and terminal reason:
   - `gap_converged`,
   - `runtime_budget`,
   - `max_iterations`,
   - `contraction_floor`,
   - `oracle_unavailable`.
4. Return full diagnostics object for downstream gating/telemetry.

### Files impacted
- `src/agents/projection/fw/FwLoopEngine.ts` (new file)
- `src/agents/projection/fw/types.ts` (new file)
- `tests/unit/fw-loop-engine.test.ts` (new file)

### End goal
FW projection has a true fully-corrective loop with active-set/hull updates and adaptive contraction.

### Acceptance criteria
- [ ] Multiple-iteration active-set progression is exercised in tests.
- [ ] Gap-based stopping is enforced and deterministic.
- [ ] Contraction path is triggered and bounded by policy.
- [ ] Terminal diagnostics include iteration/gap/contraction outcomes.

---

## Task 4 — Extend Oracle Contract For Iterative LMO Diagnostics

### Reasoning
The loop depends on robust per-iteration oracle diagnostics and warm-start behavior to stay within runtime budgets.

### What to do
Extend oracle request/response contracts to support iterative LMO solves with explicit diagnostics for loop control.

### How
1. Extend `IpOracleRequest`/`IpOracleResponse` with iterative metadata:
   - request: `iteration`, `loopId`, enhanced `warmStartHint` semantics,
   - response: `bestBound`, normalized `relativeGap`, `diagnostics` completeness.
2. Ensure sidecar returns stable objective/gap/bound values for each iteration.
3. Preserve backward compatibility for existing one-shot solve callers.
4. Add tests for timeout/error/feasible/optimal behavior under loop usage.

### Files impacted
- `src/services/ip-oracle/IpOracleClient.ts`
- `services/ip-oracle/app.py`
- `tests/unit/ip-oracle-client.test.ts`
- `tests/integration/ip-oracle-sidecar-smoke.test.ts`

### End goal
FW loop gets reliable, iteration-grade oracle feedback without breaking current sidecar integration.

### Acceptance criteria
- [ ] Oracle client supports loop metadata and remains backward-compatible.
- [ ] Sidecar response includes consistent gap/bound diagnostics.
- [ ] Tests cover iterative timeout and feasible fallback behavior.

---

## Task 5 — Rework FwProjectionAgent To Use FW Loop Engine

### Reasoning
Current `FwProjectionAgent` is one-shot; it must become loop-driven and emit richer outputs for gating/execution.

### What to do
Refactor `FwProjectionAgent` to orchestrate FW loop execution and generate either single-market fallback or FW basket opportunities from converged iterate.

### How
1. Replace one-shot per-pair internals with a global-universe loop entrypoint:
   - add `projectUniverse(...)` as the primary API,
   - keep `projectPair(...)` only as a compatibility wrapper (delegating to `projectUniverse(...)` on a narrowed universe),
   - run `FwLoopEngine` once per universe pass and derive terminal iterate + diagnostics.
2. Compute lower-bound edges using loop output and current cost/risk buffers.
3. Build basket candidate from selected active-set contribution:
   - selected markets constrained by `fwBasketMinMarkets`/`fwBasketMaxMarkets`.
   - basket legs constrained to Phase 1 pair-buy direction only.
4. Preserve existing rejection reasons and add loop-specific reasons:
   - `fw_gap_not_converged`,
   - `fw_contraction_floor`,
   - `fw_loop_runtime_exceeded`.
5. Maintain compatibility path when basket disabled:
   - continue emitting single-market `fw_projection` opportunities.

### Files impacted
- `src/agents/projection/FwProjectionAgent.ts`
- `tests/unit/fw-projection-agent.test.ts`

### End goal
Projection agent provides true loop-derived FW outputs and basket candidates with full diagnostics.

### Acceptance criteria
- [ ] Loop diagnostics are attached to FW metadata.
- [ ] Basket candidate generation is deterministic and policy-bounded.
- [ ] Non-gap-converged FW outputs are rejected from executable opportunity emission.
- [ ] Existing single-market mode remains operational when basket disabled.

---

## Task 6 — Add Basket-Aware Gates And Aggregate FW Validation

### Reasoning
Basket opportunities must be rejected early if any leg or aggregate condition violates safety thresholds.

### What to do
Add basket gate evaluation that validates per-market legs plus aggregate constraints before risk/execution.

### How
1. Add `evaluateFwBasketGates` in `src/domain/gates.ts`.
2. For each basket market pair:
   - validate quote sanity,
   - freshness/skew/stability,
   - depth/slippage constraints at target size.
3. Add aggregate checks:
   - minimum market count,
   - maximum market count (Phase 1 leg count remains derived as `2 * selectedMarkets`, with policy cap implied by `2 * fwBasketMaxMarkets`),
   - aggregate lower bound threshold,
   - basket projection age ceiling.
4. Return detailed reason array with market-scoped reason labels.

### Files impacted
- `src/domain/gates.ts`
- `tests/unit/gates.test.ts`

### End goal
Basket gate decision blocks unsafe baskets before risk sizing and execution.

### Acceptance criteria
- [ ] Gates fail when any required leg is stale/invalid/under-depth.
- [ ] Aggregate basket constraints are enforced.
- [ ] Reason labels include both aggregate and per-market failures.

---

## Task 7 — Extend RiskAgent For Basket Sizing And Exposure Constraints

### Reasoning
Risk sizing currently assumes one market; basket trades need aggregate and per-market exposure accounting in one decision.

### What to do
Add basket-aware risk evaluation that computes feasible basket size/notional under both global and per-market limits.

### How
1. Add basket risk inputs and decision path in `RiskAgent`.
2. Compute constraints for:
   - aggregate basket notional,
   - per-market exposure headroom,
   - daily loss and unwind budgets,
   - FW notional caps (`fwMaxPerMarketNotional`, `fwMaxPortfolioNotional`).
3. Return basket-specific binding constraints and rejection reasons.
4. Keep existing single-market risk behavior unchanged.

### Files impacted
- `src/agents/risk/RiskAgent.ts`
- `tests/unit/risk.test.ts`

### End goal
Risk engine can approve/reject basket opportunities with transparent, bounded sizing logic.

### Acceptance criteria
- [ ] Basket size is bounded by tightest aggregate/per-market constraint.
- [ ] Rejections identify binding basket constraint.
- [ ] Existing non-basket risk tests still pass.

---

## Task 8 — Add Basket Opportunity Routing In Scanner/Supervisor

### Reasoning
Supervisor currently routes per-market opportunities and tracks one market in-flight per execution; basket routing needs multi-market ownership and conflict controls.

### What to do
Introduce FW basket emission and supervisor handling that reserves all impacted markets atomically before execution.

### How
1. Add scanner API for global FW pass outputs (plus optional per-pair compatibility wrapper).
2. Update supervisor market-update flow to collect FW basket candidates.
   - run FW loop globally once per market-update tick and reuse result for candidate routing.
3. Add in-flight reservation model for market sets:
   - reject basket if any constituent market is already in-flight,
   - reserve/release all basket markets together.
4. Gate and risk-evaluate basket before execution call.
5. Preserve existing per-market flow for non-basket strategies.

### Files impacted
- `src/agents/scanner/ScannerAgent.ts`
- `src/core/Supervisor.ts`
- `tests/unit/supervisor-reconciliation.test.ts`

### End goal
Supervisor can safely route basket opportunities without breaking existing concurrency/capital protections.

### Acceptance criteria
- [ ] Basket reservations are atomic across all basket markets.
- [ ] Conflicting in-flight markets reject new basket opportunities.
- [ ] Legacy non-basket routing remains unchanged.

---

## Task 9 — Implement Basket Execution State Machine And Order Flow

### Reasoning
Execution is currently hard-coded to 2-leg paired flow; full basket support needs generalized per-leg lifecycle and coordinated failure handling.

### What to do
Implement basket execution lifecycle with batch/sequential submit modes, fill tracking, cancellation, and unwind handling.

### How
1. Add basket execution state model:
   - per-leg submit/ack/fill status,
   - basket terminal states (`submitted`, `failed`, `partial_fill`, `unwinding`, `complete`).
2. Add `ExecutionAgent.executeBasketArbitrage` path.
3. Submission modes:
   - `batch_best_effort`: attempt `createBatchOrders` first; if batch is unsupported/unavailable or fails before any accepted leg, fallback to `sequential_failfast`,
   - `sequential_failfast`: submit legs in deterministic order and stop on first failure.
   - default mode is `sequential_failfast`.
4. Fill handling:
   - wait for per-order outcomes via user channel,
   - on partial fill, cancel remaining orders and unwind filled legs.
5. Add basket idempotency keys and per-leg idempotency records.

### Files impacted
- `src/domain/execution.ts` (or split basket state to new module)
- `src/agents/execution/ExecutionAgent.ts`
- `src/services/PolymarketClob.ts` (payload helpers/typing reuse)
- `tests/unit/execution.test.ts`
- `tests/unit/execution-state.test.ts`

### End goal
Execution layer can run a multi-market basket safely with deterministic failure recovery.

### Acceptance criteria
- [ ] Basket orders can be submitted via configured mode.
- [ ] Batch-mode fallback to sequential mode is deterministic and idempotent-safe (no duplicate leg submission after partial batch acceptance).
- [ ] Partial-fill path cancels/unwinds correctly.
- [ ] Metrics/idempotency are recorded per basket and per leg.

---

## Task 10 — Add FW Loop And Basket Telemetry, API Exposure, And Dashboard Visibility

### Reasoning
Operators need to see convergence quality and basket behavior in runtime, or rollout decisions will be blind.

### What to do
Add loop/basket metrics/events and expose them to existing ops views.

### How
1. Add telemetry event types:
   - `fw_iteration`,
   - `fw_gap`,
   - `fw_contraction`,
   - `fw_active_set`,
   - `fw_basket`.
2. Emit events from loop/projection/supervisor/execution transitions.
3. Ensure `/metrics` snapshot includes new counters.
4. Add dashboard cards/tables for loop convergence and basket outcomes.

### Files impacted
- `src/telemetry/metrics.ts`
- `src/telemetry/events.ts`
- `src/api/server.ts` (if additional projection diagnostics endpoint is added)
- `dashboard/src/pages/Overview.tsx`
- `dashboard/src/pages/Decisions.tsx`
- `tests/unit/telemetry.test.ts`
- `tests/unit/api-config.test.ts`

### End goal
FW loop quality and basket execution behavior are observable in real time and in persisted decisions.

### Acceptance criteria
- [ ] Metrics counters include loop and basket dimensions.
- [ ] Decisions payloads preserve basket/loop metadata.
- [ ] Dashboard surfaces new metrics without regressions.

---

## Task 11 — Verification Matrix, Rollout Stages, And Safety Gates

### Reasoning
Given strategy and execution complexity, rollout must be staged with explicit stop/go criteria.

### What to do
Define verification matrix and staged rollout from replay to paper with hard safety gates.

### How
1. Verification matrix must cover:
   - FW loop convergence correctness,
   - contraction behavior,
   - basket gate/risk correctness,
   - basket partial-fill/unwind recovery,
   - telemetry completeness.
2. Required quality gates for each implementation slice:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run build`
   - `npm run test`
   - `npm run test:coverage`
   - `npm --prefix dashboard run build`
   - `npm --prefix dashboard run test:e2e`
3. Runtime rollout phases:
   - Replay: loop convergence and basket generation only; no order placement.
   - Shadow: runtime loop + basket candidate generation + gating/risk simulation only.
   - Paper: full basket execution path with strict notional limits, aggressive kill-switch thresholds, and gap-converged outputs only.
4. Define rollback triggers:
   - prolonged non-convergence,
   - contraction-floor saturation,
   - elevated partial-fill/unwind-failed rates,
   - order velocity/OTR violations.

### Files impacted
- `docs/ADAPTIVE_FRANK_WOLFE_TECHNICAL_SPEC.md`
- `docs/Operations/runbook.md`
- `docs/Testing/strategy.md`
- tests across unit/integration files listed above

### End goal
Implementation can be deployed in controlled phases with measurable safety and quality criteria.

### Acceptance criteria
- [ ] Verification matrix is documented and test-mapped.
- [ ] Rollout stage criteria and rollback triggers are explicit.
- [ ] No phase requires bypassing existing safety controls.

---

## Task 12 — Documentation Parity And Operator Playbooks

### Reasoning
Behavior changes at projection, risk, and execution layers must be reflected in docs to avoid operational mismatch.

### What to do
Update architecture/API/operations docs for FW loop and basket execution parity.

### How
1. Update architecture docs with new loop engine and basket execution path diagrams.
2. Document config knobs and recommended defaults for loop/contraction/basket controls.
3. Add runbook procedures for diagnosing:
   - non-convergence,
   - contraction churn,
   - basket partial fills and unwind failures,
   - emergency containment via conservative basket cardinality/notional knobs.
4. Add examples of decision/metrics payloads for FW baskets.

### Files impacted
- `docs/ARCHITECTURE.md`
- `docs/ARCHITECTURE_EVENT_FLOW.asc`
- `docs/API.md`
- `docs/Operations/config-knobs.md`
- `docs/Operations/runbook.md`
- `README.md` (FW strategy summary section)

### End goal
Documentation matches runtime behavior and supports ops troubleshooting.

### Acceptance criteria
- [ ] Doc examples match final event/config contracts.
- [ ] Runbook includes failure triage for loop and basket paths.
- [ ] Config docs list all new knobs and defaults.

---

## File-by-file implementation sequence

1. `src/config/policy.ts` - Task 1 policy additions.
2. `src/config/schema.ts` - Task 1 runtime-editable schema exposure.
3. `src/config/validate.ts` - Task 1 range and inter-field validation.
4. `src/domain/opportunity.ts` - Task 1 FW loop + basket types.
5. `src/agents/projection/fw/types.ts` - Task 2 foundational loop types (new file).
6. `src/agents/projection/fw/objective.ts` - Task 2 objective/gradient math (new file).
7. `src/agents/projection/fw/simplex.ts` - Task 2 simplex utilities (new file).
8. `src/agents/projection/fw/hullSolver.ts` - Task 2 hull re-optimizer (new file).
9. `src/agents/projection/fw/FwLoopEngine.ts` - Task 3 iterative engine (new file).
10. `src/services/ip-oracle/IpOracleClient.ts` - Task 4 iterative request/response fields.
11. `services/ip-oracle/app.py` - Task 4 sidecar contract/diagnostics updates.
12. `src/agents/projection/FwProjectionAgent.ts` - Task 5 loop integration + basket generation.
13. `src/domain/gates.ts` - Task 6 basket gate evaluation.
14. `src/agents/risk/RiskAgent.ts` - Task 7 basket sizing and constraints.
15. `src/agents/scanner/ScannerAgent.ts` - Task 8 basket candidate routing.
16. `src/core/Supervisor.ts` - Task 8 in-flight market-set orchestration.
17. `src/domain/execution.ts` - Task 9 basket execution state contract.
18. `src/agents/execution/ExecutionAgent.ts` - Task 9 basket order lifecycle.
19. `src/services/PolymarketClob.ts` - Task 9 batch payload integration and typing.
20. `src/telemetry/events.ts` - Task 10 loop/basket event types.
21. `src/telemetry/metrics.ts` - Task 10 counters/snapshots.
22. `src/api/server.ts` - Task 10 API surface for new telemetry payload fields.
23. `dashboard/src/pages/Overview.tsx` - Task 10 operator metrics visibility.
24. `dashboard/src/pages/Decisions.tsx` - Task 10 basket decision visibility.
25. Test files (`tests/unit/*`, `tests/integration/*`) - Tasks 2 through 11 coverage.
26. Docs files (`docs/*`, `README.md`) - Task 12 parity.

---

## Dependencies to add

No new external runtime dependencies are required by default; implement using existing TypeScript + CP-SAT sidecar stack.

### Dependency and task mapping

| Dependency | Version | Purpose | Connected tasks |
|---------|---------|---------|---------|
| none (reuse current stack) | n/a | keep implementation frugal and avoid added operational surface | 1-12 |

### Task/subtask dependency graph

| Task | Depends on | Why |
|---------|---------|---------|
| Task 2 | Task 1 | needs loop config/types contracts |
| Task 3 | Task 2 | loop engine depends on math primitives |
| Task 4 | Task 1 | oracle contract can be extended once loop-level request/diagnostic contracts are defined |
| Task 5 | Tasks 3-4 | projection agent needs loop engine + oracle contract |
| Task 6 | Task 5 | basket gates depend on generated basket shape |
| Task 7 | Tasks 5-6 | risk sizing depends on basket payload and gate semantics |
| Task 8 | Tasks 5-7 | supervisor/scanner routing depends on basket+risk+gate contracts |
| Task 9 | Tasks 1, 5, 8 | execution depends on final opportunity shape and routing model |
| Task 10 | Tasks 5, 8, 9 | telemetry must reflect loop and execution behavior |
| Task 11 | Tasks 1-10 | rollout criteria need completed mechanics and observability |
| Task 12 | Tasks 1-11 | docs must reflect implemented contracts |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-17 | Initial full gap-closing implementation specification for fully-corrective FW loop and multi-market basket execution |
| 1.1 | 2026-02-17 | Applied locked decisions: pair-buy-only Phase 1 baskets, global loop scheduling, paper-mode convergence requirement, and default sequential fallback submission mode |
| 1.2 | 2026-02-17 | DRY audit pass: removed redundant decision restatement section and retained a single decision source in Overview |
| 1.3 | 2026-02-17 | Comprehensive audit pass: aligned global-loop API wording, tightened dependency graph ordering, encoded paper-mode convergence gate in rollout, and removed remaining redundant status section |
| 1.4 | 2026-02-17 | Comprehensive DRY audit pass: removed duplicated basket-leg knob, made convergence and batch fallback semantics explicit in acceptance criteria, and corrected Task 4 dependency edge |
