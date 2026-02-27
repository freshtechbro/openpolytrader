# Adaptive Frank-Wolfe Arbitrage Technical Specification

Document status: Implemented and verified (2026-02-17)
Date: 2026-02-16
Target system: OpenPolyTrader
Related docs:
- `docs/Adaptive_Frank-Wolfe_Arbitrage.md`
- `docs/ADAPTIVE_FRANK_WOLFE_FINDINGS_AND_INTEGRATION.md`

---

## 1. Purpose

Define a production-grade technical design for integrating Adaptive Frank-Wolfe (FW) + Bregman-projection arbitrage into OpenPolyTrader with explicit safety, execution, and rollout controls.

This specification is implementation-facing and includes:
- architecture and component responsibilities,
- data contracts and API schemas,
- algorithm definitions,
- configuration and validation rules,
- integration points in current code,
- risk controls and failure behavior,
- test and rollout acceptance criteria.

---

## 2. Locked Decisions

| Decision Area | Selected Option | Rationale |
|---|---|---|
| IP resolver | OR-Tools CP-SAT | Open-source, mature, bounded-time integer optimization, warm-start hints |
| Dependency extraction | Deterministic + LLM + Hybrid toggle | Precision + recall + resilience via mode selection |
| Rollout | Replay -> Shadow -> Paper | Risk-contained progression with measurable stop/go gates |

Hard constraint:
- No live rollout is in scope for this spec; this document ends at paper-mode readiness.

---

## 3. Scope and Non-Goals

## 3.1 In Scope
- Add a new FW projection strategy path as an additive module.
- Preserve existing near-zero and EV strategy paths.
- Introduce an IP-oracle sidecar service contract.
- Support dependency extraction modes: `deterministic`, `llm`, `hybrid`.
- Add projection-specific risk gates, telemetry, and rollout controls.

## 3.2 Non-Goals
- Replacing the core near-zero/EV engines.
- Building fully autonomous live execution from this spec.
- Redesigning event-store architecture.
- Relaxing existing risk discipline or coverage thresholds.

---

## 4. Background Constraints

1. FWMM theoretical guarantees are derived for market-maker state updates, not direct CLOB execution.
2. OpenPolyTrader operates on a non-atomic CLOB execution surface (fill risk, latency races, depth effects).
3. Therefore, projection output must be execution-adjusted before opportunity emission.

Required execution-aware trade condition:
- Compute lower bound using the canonical formula in Section 10.4.
- Trade path proceeds only when `edgeLowerBound >= fwMinEdgeThreshold` and all gates pass.

---

## 5. Functional Requirements

- `FR-1` Strategy Additivity
  - FW projection path must be additive and always active in runtime.
- `FR-2` Dependency Mode Toggle
  - Runtime-selectable `fwDependencyMode` values:
    - `deterministic`
    - `llm`
    - `hybrid`
- `FR-3` IP Oracle Contract
  - Runtime calls bounded CP-SAT sidecar with hard timeout.
- `FR-4` Deterministic Fallback
  - On oracle timeout/error/no feasible result, strategy returns no-trade with reasoned telemetry.
- `FR-5` Risk and Gate Enforcement
  - Projection opportunities must pass dedicated gate and risk checks before execution.
- `FR-6` Full Lifecycle Telemetry
  - Emit dependency, solver, projection, and gate outcomes with reason codes.
- `FR-7` Rollout Isolation
  - Replay and shadow modes must never place orders.

---

## 6. Non-Functional Requirements

- `NFR-1` Latency Budget
  - Oracle call must enforce strict upper bound (`fwOracleTimeLimitMs`).
- `NFR-2` Resource Isolation
  - Solver execution must be isolated from main Node runtime (sidecar process/container).
- `NFR-3` Deterministic Diagnostics
  - All no-trade decisions must include machine-parseable reason fields.
- `NFR-4` Safety
  - Any uncertainty defaults to skip-trade, not degraded execution.
- `NFR-5` Quality
  - Existing lint/type/build/test/coverage gates remain green.

---

## 7. High-Level Architecture

## 7.1 Existing Path (unchanged)
`MarketData -> Scanner -> Gates -> Risk -> Supervisor -> Execution -> Portfolio`

## 7.2 New Additive Path
`MarketData -> DependencyResolver -> FwProjectionAgent -> ProjectionGates -> Risk -> Supervisor -> Execution`

## 7.3 Sidecar Topology
- Main service: TypeScript runtime orchestrates policy, gating, risk, and execution.
- Sidecar service: Python OR-Tools CP-SAT process handles integer optimization.
- Communication: local HTTP or Unix socket with JSON payloads.

## 7.4 ASCII Architecture (Additive, Current Strategies Preserved)
```text
                       OPENPOLYTRADER (existing + additive FW path)

 Existing strategies (unchanged)                      New FW combinatorial path (additive)

┌───────────────┐   ┌──────────┐   ┌─────────┐       ┌────────────────────┐   ┌──────────────────┐
│ MarketData    ├──▶│ Scanner  ├──▶│ Gates   │       │ DependencyResolver │──▶│ FwProjectionAgent│
│ + EV Signals  │   │ (near0+EV)│  │ current │       │ (det/llm/hybrid)   │   │ + lower-bound    │
└───────────────┘   └──────────┘   └────┬────┘       └────────────────────┘   └─────────┬────────┘
                                         │                                            ┌────▼────────────┐
                                         │                                            │ ProjectionGates │
                                         │                                            └────┬────────────┘
                                         └─────────────────────────────────────────────────┘
                                                      shared safety/execution pipeline
                                                                  │
                                                                  ▼
                                                           ┌────────────┐
                                                           │ RiskAgent  │
                                                           └─────┬──────┘
                                                                 ▼
                                                           ┌────────────┐
                                                           │ Supervisor │
                                                           └─────┬──────┘
                                                                 ▼
                                                           ┌────────────┐
                                                           │ Execution  │
                                                           └─────┬──────┘
                                                                 ▼
                                                           ┌────────────┐
                                                           │ Portfolio  │
                                                           └────────────┘

 FW sidecar path:
 FwProjectionAgent -> IpOracleClient -> OR-Tools CP-SAT sidecar (hard timeout, best-feasible return)
```

---

## 8. Component Specification

## 8.1 `DependencyResolver`
File: `src/agents/dependency/DependencyResolver.ts` (new)

Responsibilities:
- Build dependency edges for active market set.
- Execute mode-specific extraction.
- Return normalized edge list with confidence and provenance.

Modes:
- `deterministic`
  - Rule/template parser over market metadata/question text.
- `llm`
  - LLM extraction with strict output schema and confidence scoring.
- `hybrid`
  - Run deterministic and llm; merge by policy (`union` or `consensus`).

## 8.2 `FwProjectionAgent`
File: `src/agents/projection/FwProjectionAgent.ts` (new)

Responsibilities:
- Build projection problem from market state + dependency graph.
- Call oracle client within time budget.
- Compute conservative lower bound.
- Emit projection opportunities or no-trade reasons.

## 8.3 `IpOracleClient`
File: `src/services/ip-oracle/IpOracleClient.ts` (new)

Responsibilities:
- Serialize projection objective/constraints.
- Apply timeout/circuit-breaker behavior.
- Decode sidecar response and normalize status.

## 8.4 Sidecar Service
Location: `services/ip-oracle/` (new)

Responsibilities:
- Receive optimization requests.
- Build CP-SAT model.
- Solve with hard time limit.
- Return best feasible assignment + diagnostics.

---

## 9. Data Contracts

## 9.1 Dependency Edge (TypeScript)
```ts
export type DependencySource = 'deterministic' | 'llm' | 'hybrid';

export interface DependencyEdge {
  marketA: string;
  marketB: string;
  relationType: 'mutual_exclusive' | 'implies' | 'complementary' | 'partition';
  confidence: number; // [0,1]
  source: DependencySource;
  evidence: string;
  extractedAtMs: number;
}
```

## 9.2 Projection Opportunity Extension
Proposed additions to `ArbitrageOpportunity` (or specialized subtype):
```ts
export interface FwProjectionMetadata {
  projectionId: string;
  dependencyMode: 'deterministic' | 'llm' | 'hybrid';
  dependencyConfidence: number;
  projectedEdge: number;
  edgeLowerBound: number;
  solverRuntimeMs: number;
  solverStatus: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
  projectionAgeMs: number;
}
```

## 9.3 IP Oracle Request
```json
{
  "requestId": "string",
  "timeLimitMs": 120,
  "seed": 42,
  "objective": {
    "variables": ["x1", "x2", "x3"],
    "coefficients": [0.12, -0.03, 0.05],
    "sense": "min"
  },
  "constraints": {
    "type": "linear_binary",
    "rows": [
      { "coefficients": [1, 1, 0], "op": "<=", "rhs": 1 },
      { "coefficients": [0, 1, 1], "op": "<=", "rhs": 1 }
    ]
  },
  "warmStartHint": {
    "variables": ["x1", "x2", "x3"],
    "values": [1, 0, 0]
  }
}
```

## 9.4 IP Oracle Response
```json
{
  "requestId": "string",
  "status": "feasible",
  "objectiveValue": -0.07,
  "assignment": { "x1": 1, "x2": 0, "x3": 0 },
  "gap": 0.01,
  "runtimeMs": 117,
  "diagnostics": {
    "conflicts": 102,
    "branches": 840,
    "restarts": 4
  },
  "error": null
}
```

---

## 10. Algorithm Specification

## 10.1 Deterministic Dependency Extraction
Rules operate on market metadata (`marketId`, question, tags, category):
- Complement/opposite recognition.
- Mutually exclusive candidate detection.
- Partition detection for categorical markets.
- Temporal implication/exclusivity templates.

Output requirements:
- deterministic reason code for each edge.
- confidence based on rule certainty.

## 10.2 LLM Dependency Extraction
- Input: bounded market batch with normalized text.
- Output: strict JSON schema only.
- Validation: reject malformed entries and out-of-range confidences.
- Rate and cost control inherited from existing LLM framework.

## 10.3 Hybrid Merge Logic
Pseudo-definition:
```text
if mode == deterministic:
  edges = deterministicEdges
if mode == llm:
  edges = llmEdges
if mode == hybrid:
  if fwDependencyHybridMerge == consensus:
    edges = intersectByRelation(deterministicEdges, llmEdges)
  else:
    edges = unionWithConfidenceAggregation(deterministicEdges, llmEdges)

edges = filter(edge.confidence >= fwDependencyMinConfidence)
edges = capPerMarket(fwDependencyMaxEdgesPerMarket)
```

## 10.4 Projection and Opportunity Emission
```text
1. Build dependency graph G.
2. Construct linear objective + binary/integer constraints.
3. Call CP-SAT oracle with timeLimitMs.
4. If status not in {optimal, feasible}: emit no-trade(reason=solver_status).
5. Compute projectedEdge.
6. Compute lower bound:
   edgeLowerBound = projectedEdge - feeCost - slippageCost - executionRiskBuffer - stalenessPenalty
7. If edgeLowerBound < fwMinEdgeThreshold: no-trade(reason=edge_lower_bound).
8. Run projection-specific gates + RiskAgent.
9. Emit opportunity to Supervisor only if all checks pass.
```

---

## 11. Configuration Specification

## 11.1 Policy Keys (new)
Add to `src/config/policy.ts` and `src/config/schema.ts`:
- `fwDependencyMode: 'deterministic' | 'llm' | 'hybrid'`
- `fwDependencyHybridMerge: 'consensus' | 'union'`
- `fwDependencyMinConfidence: number`
- `fwDependencyMaxEdgesPerMarket: number`
- `fwOracleTimeLimitMs: number`
- `fwOracleMaxConcurrency: number`
- `fwMaxProjectionAgeMs: number`
- `fwExecutionRiskBufferBps: number`
- `fwMinEdgeThreshold: number`
- `fwMaxPerMarketNotional: number`
- `fwMaxPortfolioNotional: number`

## 11.2 Environment Keys (new)
Add to `src/config/env.ts`:
- `FW_ORACLE_BASE_URL`
- `FW_ORACLE_TIMEOUT_MS`
- `FW_ORACLE_API_KEY` (optional, if sidecar networked)
- `FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD`
- `FW_ORACLE_CIRCUIT_COOLDOWN_MS`

## 11.3 Validation Rules
Add to `src/config/validate.ts`:
- `fwOracleTimeLimitMs > 0`.
- `fwDependencyMinConfidence` in `[0,1]`.
- `fwMinEdgeThreshold > 0`.
- `fwMaxProjectionAgeMs > 0`.
- `fwMaxPerMarketNotional <= fwMaxPortfolioNotional` when both > 0.

---

## 12. Integration Points (Current Files)

Primary updates:
- `src/domain/opportunity.ts`
  - extend opportunity types/metadata for FW projection path.
- `src/agents/scanner/ScannerAgent.ts`
  - invoke projection flow and emit FW opportunities.
- `src/domain/gates.ts`
  - add `evaluateFwProjectionGates(...)`.
- `src/agents/risk/RiskAgent.ts`
  - add FW-specific caps and binding reason output.
- `src/core/Supervisor.ts`
  - route/revalidate FW opportunities before execution.
- `src/agents/execution/ExecutionAgent.ts`
  - support FW execution plans (multi-leg fail-fast semantics).
- `src/main.ts`
  - wire resolver, projection agent, and oracle client.
- `src/config/policy.ts`, `src/config/schema.ts`, `src/config/validate.ts`, `src/config/env.ts`
  - config surface and guardrails.
- `src/telemetry/metrics.ts`, `src/telemetry/events.ts`
  - event types and metrics payloads.
Note:
- New FW component files are defined in Section 8 to avoid duplication.

---

## 13. Failure Modes and Fallback Behavior

| Failure | Detection | Fallback |
|---|---|---|
| Sidecar timeout | client timeout / status timeout | no-trade + metric `fw_oracle_timeout` |
| Sidecar unavailable | connection error/circuit open | no-trade + metric `fw_oracle_unavailable` |
| No feasible solution | solver status infeasible | no-trade + metric `fw_oracle_infeasible` |
| Low dependency confidence | confidence check fails | no-trade + metric `fw_dependency_low_confidence` |
| Stale projection | projectionAge > max | no-trade + metric `fw_projection_stale` |
| Edge lower bound negative | bound check fails | no-trade + metric `fw_edge_lower_bound_fail` |
| Risk/gate reject | existing rejection pipeline | reject with reason array and diagnostics |

Safety rule:
- Any missing/invalid critical input => skip-trade.

---

## 14. Telemetry Specification

## 14.1 New Metric Event Types
Add to `MetricEventType`:
- `fw_projection`
- `fw_dependency`
- `fw_oracle`

## 14.2 Example Payloads
`fw_dependency`:
```json
{
  "event": "dependency_graph_built",
  "mode": "hybrid",
  "edgeCount": 24,
  "markets": 18,
  "confidenceMin": 0.62
}
```

`fw_oracle`:
```json
{
  "event": "oracle_solve",
  "status": "feasible",
  "runtimeMs": 97,
  "timeLimitMs": 120,
  "gap": 0.01
}
```

`fw_projection`:
```json
{
  "event": "projection_selected",
  "marketId": "abc",
  "projectedEdge": 0.014,
  "edgeLowerBound": 0.006,
  "dependencyMode": "hybrid"
}
```

---

## 15. Security and Operations

- Sidecar must run with least privilege and isolated CPU/memory limits.
- Do not expose sidecar publicly by default.
- If networked, require auth token and request size limits.
- Log redaction applies to market/user-sensitive fields.
- Circuit-break oracle client after repeated failures.

---

## 16. Test Strategy and Acceptance Criteria

## 16.1 Unit Tests
- dependency resolver deterministic rule coverage.
- llm schema validation and malformed output handling.
- hybrid merge (`consensus` and `union`) behavior.
- oracle client timeout/error/status mapping.
- projection lower-bound arithmetic correctness.
- FW gate decision reasons and edge cases.

## 16.2 Integration Tests
- scanner -> supervisor pipeline for FW opportunities.
- fail-safe behavior when oracle unavailable.
- risk cap enforcement and binding reason visibility.
- telemetry event emission completeness.

## 16.3 Replay Validation
Pass criteria:
- oracle timeout rate <= configured threshold.
- positive lower-bound precision >= configured threshold.
- no policy violations.

## 16.4 Shadow Validation
Pass criteria:
- no order submissions.
- stable compute overhead under burst conditions.
- rejection/reason telemetry complete and bounded.

## 16.5 Paper Validation
Pass criteria:
- no critical incidents attributable to FW path.
- conservative PnL and fill-quality metrics above minimum target.
- stable operation across full monitoring window.

---

## 17. Rollout Specification

| Stage | Operating Mode | Required Behavior | Exit Criteria |
|---|---|---|---|
| Replay | offline replay harness | no execution calls; generate solver/dependency quality report | meet Section 16.3 criteria |
| Shadow | live read-only | no order placement; monitor latency, stale-projection rate, lower-bound outcomes | meet Section 16.4 criteria for sustained window |
| Paper | simulated execution | strict conservative sizing; aggressive kill-switch thresholds | meet Section 16.5 criteria |

---

## 18. Open Questions (Resolved)

- `Q1` Should IP-oracle smoke tests be mandatory in default local test runs?
  - Resolution (2026-02-17): yes when sidecar deps are installed; otherwise auto-skip with explicit prerequisite detection (`python + fastapi + uvicorn + ortools`) to keep local DX reliable.
- `Q2` Should `fwDependencyHybridMerge` default remain `consensus` in execution-adjacent modes?
  - Resolution (2026-02-17): yes. Keep `consensus` for paper/live-adjacent safety and reserve `union` for replay diagnostics.
- `Q3` Should dependency metadata source prioritize catalog refresh metadata over static config?
  - Resolution (2026-02-17): yes. Prefer refreshed runtime metadata (`question/category/tags`) and only fall back to static `marketId` data when metadata is unavailable.

---

## 19. Implementation Checklist

- [x] Add new policy/env/schema keys and validations.
- [x] Implement `DependencyResolver` with three modes.
- [x] Implement CP-SAT sidecar and `IpOracleClient`.
- [x] Implement `FwProjectionAgent` and scanner integration.
- [x] Add FW projection gates and risk checks.
- [x] Wire supervisor/execution integration path.
- [x] Add telemetry events and dashboards.
- [x] Add replay/shadow/paper rollout controls and verification tests.

---

## 20. References

- FWMM paper: https://www.columbia.edu/~ck2945/papers/milp_market.pdf
- IMDEA empirical study: https://arxiv.org/html/2508.03474v1
- OR-Tools CP-SAT: https://developers.google.com/optimization/cp/cp_solver
- OR-Tools CP tasks/time limits: https://developers.google.com/optimization/cp/cp_tasks
- OR-Tools CP model reference: https://developers.google.com/optimization/reference/python/sat/python/cp_model
- OR-Tools releases: https://github.com/google/or-tools/releases
- Polymarket CLOB intro: https://docs.polymarket.com/developers/CLOB/introduction
- Polymarket orderbook summary: https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary
- Polymarket batch orders: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
- Polymarket maker rebates and fees: https://docs.polymarket.com/developers/market-makers/maker-rebates-program

---

## 21. Implementation Audit (2026-02-17)

- `src/core/Supervisor.ts` now passes rich dependency inputs (`marketId`, `yesTokenId`, `noTokenId`, `question`, `category`, `tags`) into FW scans.
- `src/agents/projection/FwProjectionAgent.ts` now builds multi-market combinatorial objective/constraints and maps dependency relations:
  - `mutual_exclusive` / `partition` -> `x_i + x_j <= 1`
  - `implies` -> `x_i - x_j <= 0`
  - `complementary` -> `x_i - x_j = 0`
- `services/ip-oracle/app.py` is runnable with bounded `/solve` behavior and smoke coverage via `tests/integration/ip-oracle-sidecar-smoke.test.ts`.
- FW metadata plumbing (`question/category/tags`) is wired in catalog + refresher + runtime supervisor path.
- Dashboard overview exposes FW telemetry counters (`fw_projection`, `fw_dependency`, `fw_oracle`) via `dashboard/src/pages/Overview.tsx`.
- Full quality gates validated in this implementation cycle:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run build`
  - `npm run test`
  - `npm run test:coverage` (branch coverage `97.03%`, threshold `97.01%`)
  - `npm --prefix dashboard run build`
  - `npm --prefix dashboard run test:e2e`
