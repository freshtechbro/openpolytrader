# FW Intent Throughput Remediation Spec

Risk-neutral spec to increase Frank-Wolfe (FW) intent pass-through without widening risk exposure.

---

## Overview

### Current runtime findings
- FW funnel in the investigated window (`ts >= 1772074597576`):
  - detected: `220`
  - risk approved: `220`
  - gate rejected: `219`
  - gated intents: `0`
  - FW orders: `0`
- Dominant reject reasons:
  - `fw_basket:*:edge_below_threshold` on all rejected FW baskets
  - `fw_basket_projection_stale` and `fw_basket:*:fw_projection_stale` on most rejected FW baskets
- Measured latency pressure:
  - FW risk-approved latency avg `7627.4ms` (min `5400ms`, max `26890ms`)
  - active `maxDecisionLatencyMs` is `800ms`

### Scope
- Improve FW throughput strictly by reducing stale/invalid FW candidates and hot-path latency.
- Keep risk constraints unchanged or tighter.
- Preserve current final-intent contract (`latency.stage='gated'` and/or `order` event).

### Key decisions
- Execute in this order:
  - 1) config-only FW dependency mode switch off hybrid hot path
  - 2) dependency extraction cache/backoff hardening
  - 3) executable-leg enforcement in basket construction
- No reduction of `fwMinEdgeThreshold`, no staleness threshold relaxation without compensating controls.

### Directional success checks (5-minute windows)
- Evaluate using baseline + 3 consecutive post-change windows per stage.
- Directional success (no fixed throughput target):
  - `risk_approved -> gated` conversion improves in at least `2/3` windows.
  - `risk_approved -> gated` latency p95 decreases in at least `2/3` windows.
  - `gate_rejection` mix improves in at least `2/3` windows (especially `edge_below_threshold` + stale reasons).
- Conversion formula per window: `gated / risk_approved`, where `risk_approved` is counted from `latency.stage='risk_approved'`.
- If `risk_approved=0` in a window, use `gated` count trend only for that window.
- Intent flow proof:
  - if baseline `gated` is `0`, at least one post-change window must show `gated > 0`.
- Risk envelope invariant:
  - do not lower `fwMinEdgeThreshold`.
  - do not loosen staleness limits without compensating tightening.

---

## Task 1 — Switch FW Dependency Mode Off Hybrid Hot Path (Config-Only)

### Reasoning
FW dependency extraction currently sits in the projection hot path and frequently incurs high LLM latency with invalid output. This causes stale opportunities before final gates. A config-level mode shift gives immediate relief with minimal change risk.

### What to do
Set `fwDependencyMode=deterministic` in the currently active risk profile, then verify directional conversion/latency improvement.

### How
1. Resolve active profile first:
   - read `settings/risk-gates/active.json` (or `GET /config/risk-profiles`).
2. Update the resolved active profile file:
   - set `"fwDependencyMode": "deterministic"`.
3. Apply active profile in runtime (`POST /config/risk-profile` with active id) or restart.
4. Verify FW runtime behavior over 3x5-minute windows:
   - hot-path `fw_dependency` LLM extraction calls are zero.
   - `risk_approved -> gated` conversion improves in at least `2/3` windows vs baseline.
   - `risk_approved -> gated` latency p95 is lower in at least `2/3` windows vs baseline.
5. Confirm no risk-surface widening:
   - no changes to edge/staleness/depth/slippage risk thresholds in this task.

### Files impacted
- `settings/risk-gates/active.json` (active profile lookup)
- `settings/risk-gates/<active-profile>.json`
- `docs/Operations/config-knobs.md` (document mode intent and operational fallback)
- `docs/Operations/runbook.md` (add verification checklist)

### End goal
Remove LLM dependency extraction from FW critical path immediately, reducing stale FW opportunities before gate evaluation.

### Acceptance criteria
- [ ] Resolved active profile and runtime config both use `fwDependencyMode=deterministic`.
- [ ] FW dependency extraction LLM calls in hot path are zero while deterministic mode is active.
- [ ] Conversion trend (`risk_approved -> gated`) improves in at least `2/3` post-change windows.
- [ ] Latency trend (`risk_approved -> gated` p95) improves in at least `2/3` post-change windows.
- [ ] If baseline `gated=0`, at least one post-change window has `gated > 0`.
- [ ] No risk threshold values are loosened in this task.

---

## Task 2 — Add Dependency Extraction Cache and Backoff

### Reasoning
Hybrid mode may still be desired long term. Without caching/backoff, repeated invalid or slow LLM responses repeatedly tax the hot path and produce stale opportunities.

### What to do
Add bounded cache and failure backoff to dependency extraction/resolution so hybrid mode remains usable without repeated latency spikes.

### How
1. Introduce resolver/extractor controls:
   - cache TTL for resolved dependency edges keyed by market universe signature.
   - bounded max entries (LRU or equivalent).
   - reason-aware backoff after invalid output/timeout/error.
2. Implement fallback behavior:
   - on extraction failure, serve recent cached edges when within TTL/grace.
   - otherwise fall back to deterministic edges.
3. Add observability:
   - emit counters/events for cache hit, cache miss, cache stale, backoff active, fallback source.
4. Add config/schema validation for new knobs and safe defaults.
5. Add tests for:
   - cache hit/miss/expiry
   - invalid output backoff
   - bounded cache eviction
   - deterministic fallback correctness

### Files impacted
- `src/agents/dependency/DependencyResolver.ts`
- `src/agents/dependency/DependencyLLMExtractor.ts`
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`
- `tests/unit/dependency-resolver.test.ts`
- `tests/unit/dependency-llm-extractor.test.ts`

### End goal
Hybrid dependency mode can run without repeated LLM-induced latency amplification or unstable output loops.

### Acceptance criteria
- [ ] Hybrid mode reuses cached dependency results within TTL.
- [ ] Invalid-output bursts trigger backoff and suppress repeated hot-path LLM calls.
- [ ] Cache remains bounded by configured entry limit.
- [ ] Unit tests cover cache/backoff/fallback paths and pass.

---

## Task 3 — Enforce Executable-Leg Eligibility in FW Basket Builder

### Reasoning
Current basket selection can produce aggregate-positive baskets while selected legs are not executable under downstream per-leg gate rules (`edge_below_threshold`). This creates high false-positive FW flow and near-certain gate rejection.

### What to do
Require each selected basket leg to satisfy executable economics aligned with downstream gate semantics before basket creation.

### How
1. Reuse downstream gate semantics for per-leg executability (no duplicated math):
   - evaluate each leg with the same fee/slippage/tick/depth/edge checks used downstream for execution eligibility.
   - include the same lower-bound/threshold checks (`minEdgeTicks`, spread, slippage, depth, fee-adjusted edge where applicable).
   - exclude cross-leg-only checks (for example leg-skew coupling) from this per-leg pre-filter.
   - a leg is eligible only if the shared downstream-aligned check passes.
2. Apply criterion before `buildBasketOpportunity` selection.
3. Emit candidate filter diagnostics:
   - rejected by non-executable leg count.
   - exact downstream-aligned reject reason id per leg.
4. Keep risk-neutral constraints:
   - do not lower edge thresholds.
   - only remove candidates that are non-executable or below threshold.
5. Add tests:
   - baskets are not built from non-executable legs.
   - valid executable-leg candidates continue to build baskets.
   - diagnostics reason ids match downstream reject reason ids.

### Files impacted
- `src/agents/projection/FwProjectionAgent.ts`
- `src/domain/opportunity.ts` (if additional basket-leg metadata is required)
- `tests/unit/fw-projection-agent.test.ts`
- `tests/unit/gates.test.ts` (alignment assertions)

### End goal
FW basket construction produces candidates that can pass downstream per-leg gate checks, increasing real gated intent throughput without increasing risk.

### Acceptance criteria
- [ ] Basket legs failing the shared downstream-aligned executability check are filtered pre-gate.
- [ ] Filter diagnostics emit downstream-aligned reason ids for rejected legs.
- [ ] Per-leg `edge_below_threshold` FW gate-rejection share decreases in at least `2/3` post-change windows.
- [ ] If baseline `gated=0`, at least one post-change window has `gated > 0`.
- [ ] No risk threshold is relaxed to achieve throughput gain.
- [ ] Unit tests for executable-leg eligibility and diagnostics pass.

---

## File-by-File Implementation Sequence

1. `settings/risk-gates/active.json` — resolve active profile id for Task 1.
2. `settings/risk-gates/<active-profile>.json` — Task 1 config switch.
3. `docs/Operations/config-knobs.md` — Task 1 operational documentation.
4. `docs/Operations/runbook.md` — Task 1 verification procedure.
5. `src/config/policy.ts` — Task 2 cache/backoff knobs.
6. `src/config/schema.ts` — Task 2 runtime-editable schema entries.
7. `src/config/validate.ts` — Task 2 bounds/consistency checks.
8. `src/agents/dependency/DependencyResolver.ts` — Task 2 cache + fallback logic.
9. `src/agents/dependency/DependencyLLMExtractor.ts` — Task 2 backoff + failure handling.
10. `tests/unit/dependency-resolver.test.ts` — Task 2 verification.
11. `tests/unit/dependency-llm-extractor.test.ts` — Task 2 verification.
12. `src/agents/projection/FwProjectionAgent.ts` — Task 3 executable-leg filtering.
13. `src/domain/opportunity.ts` — Task 3 optional metadata extension.
14. `tests/unit/fw-projection-agent.test.ts` — Task 3 verification.
15. `tests/unit/gates.test.ts` — Task 3 alignment coverage.

---

## Dependencies to Add

No new package dependencies required for this remediation sequence.

| Package | Version | Purpose |
|---------|---------|---------|
| N/A | N/A | Existing codepaths and utilities are sufficient |

---

## Dependency Mapping (Tasks/Subtasks)

- Task 1 is independent and should ship first for immediate throughput relief.
- Task 2 depends on Task 1 for rollout safety only (not code dependency).
- Before Stage B, explicitly switch `fwDependencyMode` back to `hybrid` for test validation.
- Task 3 depends on existing projection/gate semantics and should follow Task 2 to avoid conflating latency and eligibility effects.

---

## Rollout and Safety Gates

- Stage A: Task 1 only (`deterministic`), capture baseline + 3 post-change windows.
- Stage B: explicit mode transition to `hybrid` + Task 2, verify `/config` reflects `hybrid` before collecting windows.
- Stage C: Task 3 on the selected operating mode from Stage A/B, with projection diagnostics enabled.

Stage transition rule:
- If Stage B fails directional checks or increases risk-rejection mix, revert to `deterministic` immediately and continue with Task 3 under `deterministic`.

Hard stop conditions:
- Any increase in risk incidents attributable to threshold relaxation (prohibited).
- Any regression in gate correctness or unexpected order submissions.
- Any test/coverage gate regression.

Rollback mechanics (immediate):
1. Re-apply pre-change active risk profile (`POST /config/risk-profile` with saved pre-change id).
2. Restore prior `fwDependencyMode` value in the active profile file if it was modified.
3. Restart runtime, then verify `/config` matches expected `riskProfile`, `fwDependencyMode`, and unchanged risk thresholds.

---

## Verification Commands

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:coverage`

Suggested runtime validation queries:
- Window: fixed 5-minute boundaries per run, evaluate baseline vs each post-change window.
- For each query, replace `START_TS_MS` and `END_TS_MS` with explicit window bounds.

```sql
-- Q1: FW funnel counts for one fixed 5-minute window
WITH w AS (
  SELECT CAST(START_TS_MS AS INTEGER) AS start_ts, CAST(END_TS_MS AS INTEGER) AS end_ts
)
SELECT
  SUM(type='opportunity' AND data LIKE '%:fwb:%') AS fw_detected,
  SUM(type='latency' AND data LIKE '%\"stage\":\"risk_approved\"%' AND data LIKE '%:fwb:%') AS fw_risk_approved,
  SUM(type='latency' AND data LIKE '%\"stage\":\"gated\"%' AND data LIKE '%:fwb:%') AS fw_gated,
  SUM(type='gate_rejection' AND data LIKE '%:fwb:%') AS fw_gate_rejected,
  SUM(type='order' AND data LIKE '%:fwb:%') AS fw_orders
FROM metrics, w
WHERE ts BETWEEN w.start_ts AND w.end_ts;

-- Q2: FW gated-latency p95 for one fixed 5-minute window
WITH w AS (
  SELECT CAST(START_TS_MS AS INTEGER) AS start_ts, CAST(END_TS_MS AS INTEGER) AS end_ts
),
lat AS (
  SELECT
    COALESCE(
      CAST(json_extract(data, '$.durationMs') AS REAL),
      CAST(json_extract(data, '$.latencyMs') AS REAL),
      CAST(json_extract(data, '$.valueMs') AS REAL)
    ) AS ms
  FROM metrics, w
  WHERE ts BETWEEN w.start_ts AND w.end_ts
    AND type='latency'
    AND data LIKE '%:fwb:%'
    AND data LIKE '%\"stage\":\"gated\"%'
),
r AS (
  SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) AS rn, COUNT(*) OVER () AS n
  FROM lat
  WHERE ms IS NOT NULL
)
SELECT MAX(ms) AS fw_gated_p95_ms
FROM r
WHERE rn >= CAST((n * 0.95) AS INT);

-- Q3: FW gate-rejection reason mix for one fixed 5-minute window
WITH w AS (
  SELECT CAST(START_TS_MS AS INTEGER) AS start_ts, CAST(END_TS_MS AS INTEGER) AS end_ts
),
rej AS (
  SELECT data
  FROM metrics, w
  WHERE ts BETWEEN w.start_ts AND w.end_ts
    AND type='gate_rejection'
    AND data LIKE '%:fwb:%'
)
SELECT
  COUNT(*) AS total_rejections,
  SUM(data LIKE '%edge_below_threshold%') AS edge_below_threshold_rejections,
  SUM(data LIKE '%projection_stale%' OR data LIKE '%fw_projection_stale%') AS stale_rejections
FROM rej;
```

Pass/fail interpretation (directional):
- Conversion trend (`risk_approved -> gated`) improves in at least `2/3` windows.
- Latency p95 trend improves in at least `2/3` windows.
- Rejection-mix trend improves in at least `2/3` windows.
- If baseline `gated=0`, at least one post-change window has `gated > 0`.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-27 | Initial spec for ordered 3-step FW throughput remediation (risk-neutral) |
| 1.1 | 2026-02-27 | Patched success/acceptance criteria, active-profile handling, hybrid transition, reproducible SQL validation, and rollback mechanics |
| 1.2 | 2026-02-27 | Tightened FW attribution SQL (`:fwb:` + stage-based counts), clarified conversion formula/zero-denominator handling, and constrained Task 3 to per-leg-only checks |
