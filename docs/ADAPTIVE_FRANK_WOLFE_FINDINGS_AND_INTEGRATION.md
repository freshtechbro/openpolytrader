# Adaptive Frank-Wolfe Arbitrage: Research Findings and OpenPolyTrader Integration

Date: 2026-02-16
Status: Implemented and audited (2026-02-17 verification)
Implementation spec: `docs/ADAPTIVE_FRANK_WOLFE_TECHNICAL_SPEC.md`

---

## 1) Executive Summary

This document consolidates deep research on adaptive Frank-Wolfe (FW) + Bregman-projection arbitrage and translates it into a concrete, low-risk integration plan for OpenPolyTrader.

Key conclusion:
- Adaptive FW + IP-oracle projection is viable as a high-value secondary engine, but it must be integrated as an execution-aware overlay on top of current near-zero and EV paths, not as a full replacement.

Hard decisions selected for this integration:
- IP resolver: `OR-Tools CP-SAT`.
- Dependency extraction: `deterministic`, `llm`, and `hybrid` modes, with runtime toggle support.
- Rollout: `replay -> shadow -> paper` staged rollout.

Implementation audit snapshot (2026-02-17):
- FW path is wired end-to-end in scanner -> projection -> gates -> risk -> supervisor -> execution.
- OR-Tools sidecar is implemented at `services/ip-oracle/app.py` with `/health` and `/solve`.
- Runtime dependency extraction input now uses rich `MarketPair` metadata (`question`, `category`, `tags`) instead of `marketId`-only supervisor wiring.
- Runtime now wires a production LLM dependency extractor into resolver config (`main.ts` -> `DependencyLLMExtractor`), so `fwDependencyMode='hybrid'` combines deterministic + LLM edges end-to-end when LLM is enabled and scanner advisory mode is active.
- FW projection now submits combinatorial multi-market oracle requests (not single-variable stubs), with dependency relation constraints encoded into the CP-SAT model.
- Integration smoke coverage includes sidecar startup and feasible/infeasible solve contract checks.
- Dashboard overview now surfaces FW telemetry counters (`fw_projection`, `fw_dependency`, `fw_oracle`) for live operator visibility.

Gap closure summary (2026-02-17):
- Closed: sidecar service existed only as spec text -> now runnable with auth/size guard/time limit behavior.
- Closed: dependency extraction input quality gap -> runtime now passes rich metadata from catalog/refresher/supervisor path.
- Closed: combinatorial wiring gap -> projection agent now builds multi-variable objectives with relation constraints.
- Closed: integration confidence gap -> sidecar smoke test added and included in passing CI-local test runs.
- Closed: telemetry visibility gap -> dashboard now exposes FW-specific counters alongside core risk/ops metrics.

Open questions resolved with recommendations:
- Keep `fwDependencyHybridMerge='consensus'` as default for execution-adjacent modes; use `union` for replay diagnostics.
- Prefer refreshed runtime metadata (`question/category/tags`) over static `marketId`-only inputs whenever available.
- Keep sidecar smoke test enabled by default when Python prerequisites exist; auto-skip with explicit prerequisite checks otherwise.

---

## 2) Locked Decisions

### 2.1 IP Resolver
- Selected: OR-Tools CP-SAT.
- Why:
  - Open-source, actively maintained, production-proven for integer optimization.
  - Strong time-limit controls and solution-hint support for warm starts.
  - Better fit than generic LP/MIP backends for pure/mostly integer dependency constraints.

### 2.2 Dependency Extraction Strategy
- Selected modes:
  - `deterministic`: rule/template-driven market dependency extraction.
  - `llm`: model-driven dependency extraction.
  - `hybrid`: runs both and merges/intersects according to policy.
- Why:
  - Deterministic mode gives auditability and low false positives on known templates.
  - LLM mode improves recall on long-tail/novel market phrasings.
  - Hybrid gives best robustness and can degrade gracefully if one source fails.

### 2.3 Rollout Strategy
- Selected staged rollout: `replay -> shadow -> paper`.
- Why:
  - Keeps risk near zero while validating solver quality, dependency quality, and execution realism.
- Detailed stage goals, requirements, and exit criteria are defined in Section 7.

---

## 3) Critical Findings

### 3.1 Theoretical Guarantee vs CLOB Execution Reality
FWMM guarantees in literature are expressed for market-maker state updates and Bregman projection quality (divergence/gap relationships). OpenPolyTrader trades a CLOB with non-atomic fills, queue risk, and latency races.

Implication:
- Do not trade directly on projection objective alone.
- Convert projection output into execution-aware lower bound:
  - expected projection edge
  - minus taker/maker fee impact
  - minus depth/slippage estimate
  - minus non-atomic fill risk buffer
  - minus stale-state risk penalty

Trade only when lower bound remains positive under configured margin.

### 3.2 Public Frontier Implementations are Sparse
- There is strong academic grounding and high-quality FW libraries.
- There is limited public production-grade code for full ProjectFW-style combinatorial arbitrage on prediction market CLOBs.

Implication:
- Build a modular internal implementation with hard safety gates and staged deployment.
- Reuse mature building blocks (CP-SAT + existing OpenPolyTrader risk/execution stack), not end-to-end research repos.

### 3.3 OR-Tools CP-SAT is the Practical Open-Source Choice
- CP-SAT is the selected open-source solver for bounded-time integer optimization in this design.

Implication:
- Implement IP as sidecar service for stability and language isolation.
- Keep OpenPolyTrader TypeScript runtime focused on orchestration, gates, risk, and execution.
- Treat Section 6.3 as the canonical oracle request/response behavior and diagnostics contract.

### 3.4 OpenPolyTrader Already Has Strong Insertion Points
Current architecture already supports additive strategy paths through scanner, gates, risk, supervisor, and execution.

Detailed file-level insertion points are centralized in Section 6.5 to keep one source of truth.

### 3.5 Frontier Implementation Landscape (What Exists Today)
- Academic/algorithmic frontier:
  - FWMM/ProjectFW formulation is established in the Kroer et al. line of work.
  - Modern FW libraries (for general constrained optimization) are mature but not trading-system complete.
- Solver frontier:
  - OR-Tools CP-SAT is the most practical open-source integer-programming path for production integration.
  - Alternative open-source solvers exist (HiGHS/SCIP ecosystems), but CP-SAT has the strongest fit for bounded-time integer search loops.
- Trading-system frontier:
  - Public prediction-market bots mostly implement direct arbitrage, market making, and heuristics, not full open ProjectFW stacks with robust CLOB execution/risk controls.

Implication:
- The best path is synthesis: combine mature optimization components with OpenPolyTrader's existing risk-disciplined execution architecture, rather than expecting an off-the-shelf end-to-end reference.

---

## 4) Pros and Cons

| Area | Pros | Cons |
|---|---|---|
| Pricing quality | Can exploit combinatorial incoherence missed by pairwise checks | Projection quality can be overestimated if dependencies are wrong |
| Strategy edge | Captures multi-market arbitrage not represented in current near-zero/EV paths | Higher compute and latency budgets |
| Risk control | Works with existing risk gates and can add conservative lower-bound checks | More moving parts: dependency graph, solver service, execution coupling |
| Operational fit | Additive integration fits current architecture without replacing baseline flows | Requires new observability and incident classes |
| Open-source stack | OR-Tools CP-SAT avoids commercial lock-in | Sidecar deployment complexity and resource governance |

---

## 5) Risk Register and Mitigations

| Risk | Description | Mitigation |
|---|---|---|
| Solver timeout / instability | IP oracle misses SLA during fast markets | hard timeout, best-so-far return, fallback to no-trade, queue isolation |
| Dependency extraction error | false links create fake arbitrage | dual-source extraction + confidence scoring + manual denylist/allowlist |
| Execution non-atomicity | one leg fills, hedge leg misses | strict size caps, FOK/FAK preference, residual inventory unwind policy |
| Latency drift | solve age makes result stale | max projection age gate; mandatory book revalidation pre-submit |
| Fee/slippage underestimation | projected profit not realized | conservative fee model + depth sweep simulation + safety haircut |
| Operational overload | sidecar CPU contention affects core runtime | dedicated process/container + quotas + backpressure |
| Strategy overfitting | replay/shadow metrics look good but paper degrades | staged rollout with hard stop/go thresholds |

---

## 6) Systematic Integration Approach

## 6.1 Architecture Additions

Add a new projection subsystem without disturbing existing strategy core.

New components (proposed):
- `src/agents/projection/FwProjectionAgent.ts`
  - owns FW loop orchestration and projection lifecycle.
- `src/services/ip-oracle/IpOracleClient.ts`
  - typed client for sidecar calls.
- `src/domain/dependency.ts`
  - normalized dependency graph types and confidence metadata.
- `src/agents/dependency/DependencyResolver.ts`
  - mode-aware resolver (`deterministic|llm|hybrid`).

New sidecar (separate service):
- `services/ip-oracle/` (Python + OR-Tools CP-SAT)
  - receives linear objective and combinatorial constraints.
  - returns selected vertex/set, objective delta, status, and runtime diagnostics.

## 6.2 Dependency Extraction Modes (Toggle Support)

Policy additions (proposed):
- `fwDependencyMode: 'deterministic' | 'llm' | 'hybrid'`
- `fwDependencyHybridMerge: 'consensus' | 'union'`
- `fwDependencyMinConfidence: number`
- `fwDependencyMaxEdgesPerMarket: number`

Mode semantics:
- `deterministic`:
  - parse market metadata/questions using known templates (election, binary opposite, categorical partition, temporal exclusivity).
  - output high-precision graph edges with deterministic reason codes.
- `llm`:
  - infer dependency candidates with confidence score and rationale.
  - apply schema validation and confidence threshold.
- `hybrid`:
  - run both sources.
  - merge using `fwDependencyHybridMerge` (`consensus` or `union`).
  - recommended default: `consensus` for live-adjacent modes and `union` in replay.

Output contract:
- dependency edge: `(marketA, marketB, relationType, confidence, source, evidence)`.

## 6.3 IP Oracle Contract (OR-Tools CP-SAT)

Request (conceptual):
- `objective`: linear coefficients for current projection step.
- `constraints`: integer/binary relation matrix form.
- `warmStartHint`: optional prior feasible assignment.
- `timeLimitMs`: strict upper bound.
- `seed`: optional repeatability control.

Response (conceptual):
- `status`: optimal/feasible/infeasible/unknown/timeout.
- `assignment`: best assignment found.
- `objectiveValue`.
- `gap` (if available).
- `runtimeMs`.
- `diagnostics` (nodes, restarts, conflicts where available).

Required behavior:
- return best feasible solution on timeout when possible.
- never block caller past hard timeout.
- include explicit reason codes for no-solution outcomes.

## 6.4 Projection Engine Flow

1. Build dependency graph from selected mode.
2. Generate constrained projection problem.
3. Call IP oracle with bounded time + warm hint.
4. Compute projection benefit and conservative lower bound.
5. Emit opportunity only if all gates pass and lower bound > threshold.

Conservative lower bound check (required):
- `projectionEdgeLowerBound = projectedEdge - feeCost - slippageCost - executionRiskBuffer - stalePenalty`
- proceed only when `projectionEdgeLowerBound >= fwMinEdgeThreshold`.

## 6.5 Integration Points in Current Repo

Scanner/opportunity:
- `src/agents/scanner/ScannerAgent.ts`
  - add projection opportunity generation path.
- `src/domain/opportunity.ts`
  - add new opportunity type, e.g. `type: 'fw_projection'`.

Gates/risk:
- `src/domain/gates.ts`
  - add projection-specific gate function (freshness, dependency confidence, projection age, execution bound).
- `src/agents/risk/RiskAgent.ts`
  - add projection caps (per-market and portfolio-level notional/risk buffers).

Supervisor/execution:
- `src/core/Supervisor.ts`
  - route and revalidate projection opportunities before execution.
- `src/agents/execution/ExecutionAgent.ts`
  - add multi-leg execution plan support with strict fail-fast semantics.

Config/wiring:
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`
- `src/config/env.ts`
- `src/main.ts`

Observability:
- `src/telemetry/metrics.ts`
- `src/telemetry/events.ts`
  - add `fw_projection` and `dependency_resolver` metrics/events.

---

## 7) Rollout Plan (Replay -> Shadow -> Paper)

### Stage 1: Replay
Goal:
- validate solver throughput, dependency quality, and bound correctness offline.

Requirements:
- event-store replayer with deterministic seeds.
- full metric capture for opportunity quality and pass/fail reasons.

Exit criteria:
- solver timeout rate below threshold.
- positive conservative bound precision above threshold.
- no unacceptable risk-rule violations.

### Stage 2: Shadow
Goal:
- run full live read/compute path with no order placement.

Requirements:
- production-like data ingestion and policy values.
- projected opportunities logged with counterfactual execution estimates.

Exit criteria:
- stable runtime overhead.
- bounded false-positive and stale-opportunity rates.
- consistent behavior under market bursts.

### Stage 3: Paper
Goal:
- validate execution/lifecycle under paper-mode semantics.

Requirements:
- strict risk caps and smaller than baseline sizing.
- full lifecycle telemetry and incident tagging.

Exit criteria:
- conservative PnL and fill-quality metrics above baseline.
- no repeated critical incident classes.
- sign-off for optional future live pilot design (not part of this rollout).

---

## 8) Recommended Initial Defaults

Policy defaults (proposed):
- FW runtime is always active; basket cardinality/notional knobs control blast radius.
- `fwDependencyMode='hybrid'`.
- `fwDependencyHybridMerge='consensus'`.
- `fwOracleTimeLimitMs=120`.
- `fwMaxProjectionAgeMs=250`.
- `fwExecutionRiskBufferBps=20`.
- `fwMinEdgeThreshold=0.005`.
- `fwMaxPerMarketNotional` and `fwMaxPortfolioNotional` conservative and below EV caps initially.

Operational defaults:
- sidecar isolated process.
- hard CPU/memory budget for solver.
- circuit-breaker on repeated oracle failures.

---

## 9) Implementation Sequence (Minimal-Risk)

1. Add config schema/validation for FW toggles and bounds.
2. Add dependency resolver (deterministic + llm + hybrid) with typed outputs.
3. Add OR-Tools CP-SAT sidecar and client contract.
4. Add projection agent and scanner integration.
5. Add projection gates/risk checks.
6. Add execution path for projection opportunities.
7. Add replay harness and metrics dashboards.
8. Run staged rollout: replay -> shadow -> paper.

---

## 10) Sources

Core methodology:
- Kroer et al., Arbitrage-Free Combinatorial Market Making via Integer Programming: https://www.columbia.edu/~ck2945/papers/milp_market.pdf

Recent empirical context:
- IMDEA study (Unravelling the Probabilistic Forest): https://arxiv.org/html/2508.03474v1

Open-source solver and optimization references:
- OR-Tools CP-SAT guide: https://developers.google.com/optimization/cp/cp_solver
- OR-Tools CP tasks/time limits: https://developers.google.com/optimization/cp/cp_tasks
- OR-Tools CP model reference (Python): https://developers.google.com/optimization/reference/python/sat/python/cp_model
- OR-Tools MIP docs: https://developers.google.com/optimization/mip/mip_example
- OR-Tools releases: https://github.com/google/or-tools/releases
- HiGHS project: https://highs.info/
- HiGHS repository: https://github.com/ERGO-Code/HiGHS
- SCIP project: https://www.scipopt.org/index.php
- FrankWolfe.jl repository: https://github.com/ZIB-IOL/FrankWolfe.jl
- FrankWolfe.jl 2025 paper: https://arxiv.org/abs/2501.14613

Execution constraints on Polymarket CLOB:
- CLOB introduction: https://docs.polymarket.com/developers/CLOB/introduction
- Orderbook summary endpoint: https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary
- Changelog: https://docs.polymarket.com/changelog
- Market websocket channel: https://docs.polymarket.com/developers/CLOB/websocket/market-channel
- Batch order endpoint: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
- Fee-rate and maker rebates docs: https://docs.polymarket.com/developers/market-makers/maker-rebates-program

Lower-maturity illustrative repositories:
- Frank-Wolfe-Implementation: https://github.com/matteomedioli/Frank-Wolfe-Implementation
- BregmanProjection: https://github.com/walidk/BregmanProjection

---

## 11) Final Recommendation

Integrate adaptive FW as a controlled, additive strategy module with CP-SAT sidecar and hybrid dependency extraction, then gate promotion through replay, shadow, and paper stages with strict conservative bound checks.

This maximizes edge discovery potential while preserving OpenPolyTrader's existing safety and risk-discipline posture.
