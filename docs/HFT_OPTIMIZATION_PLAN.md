# HFT Optimization Plan - Near-Zero Risk Preserved

**Created:** 2026-01-11  
**Status:** Ready for Implementation  
**Philosophy:** Higher frequency within near-zero risk constraints

---

## Overview

This plan optimizes OpenPolyTrader for higher trading frequency while preserving the near-zero risk philosophy. All changes maintain:
- No unhedged exposure
- Deterministic failure handling
- Edge pays for failures
- Immediate unwind capability

### User Parameters (Confirmed)
| Parameter | Value |
|-----------|-------|
| Deployment region | eu-west-1/eu-west-2 |
| Tiered edge | 2% edge with 25% sizing, stricter gates |
| Max exposure | $1000 (configurable via existing `maxMarketExposureFraction`) |
| Velocity | Track API limits (500/s burst, 60/s sustained) |

### Key Findings
- Parallel leg submission already implemented (Promise.allSettled)
- Batch order endpoint exists but unused (`createBatchOrders()`)
- Rate limiter is sliding window only (no burst capacity)
- Velocity capped at 60/min but API allows 500/s burst

---

## Task 1 — Switch to Batch Order Submission

### Reasoning
Currently, YES and NO legs are submitted as two separate REST calls. Polymarket's batch endpoint (`POST /orders`) accepts up to 15 orders in a single request, reducing round-trips from 2 to 1.

### What to do
Replace individual `createOrder()` calls with single `createBatchOrders()` call for leg pairs.

### How
1. Locate the parallel submission code in `ExecutionAgent.ts` (~line 1070-1085)
2. Replace the `Promise.allSettled([yesPromise, noPromise])` pattern with batch submission
3. Update `PolymarketClob.createBatchOrders()` to handle duplicate detection like `createOrder()` does
4. Add proper error handling for partial batch failures
5. Update idempotency record creation to handle batch responses

### Files impacted
- `src/agents/execution/ExecutionAgent.ts` (modify submission logic)
- `src/services/PolymarketClob.ts` (enhance `createBatchOrders()`)
- `tests/unit/execution.test.ts` (add batch submission tests)

### End goal
Both FOK legs submitted in single HTTP request, reducing latency by ~50-100ms.

### Acceptance criteria
- [ ] Batch order submission used for all two-leg executions
- [ ] Proper error handling for partial batch failures (one leg rejected)
- [ ] Idempotency records correctly created for batch responses
- [ ] Existing tests pass + new batch-specific tests added
- [ ] Latency telemetry shows reduced submission time

---

## Task 2 — Consolidate Rate Limiting at CLOB Boundary (Token Bucket)

### Reasoning
Current sliding window limiter blocks when limit reached and exists in multiple layers. Consolidate throttling at the CLOB boundary and use token bucket semantics to allow short bursts while maintaining sustained compliance.

### What to do
Replace `RateLimiter` implementation with token bucket semantics (same interface) and use it in CLOB/Data API clients only.

### How
1. Update `src/services/RateLimiter.ts` to use token bucket semantics while keeping its constructor signature (`maxRequestsPerWindow`, `windowMs`).
2. Compute refill rate as `maxRequestsPerWindow / windowMs` and use a non-recursive wait loop to avoid unbounded recursion under contention.
3. Keep existing env keys: `POLYMARKET_CLOB_RATE_LIMIT_PER_SEC` and `POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS` (no new env vars).
4. Use the limiter only in `PolymarketClob` and `PolymarketDataApi` (single source of truth).

### Files impacted
- `src/services/RateLimiter.ts` (token bucket semantics)
- `src/services/PolymarketClob.ts` (uses updated limiter)
- `src/services/PolymarketDataApi.ts` (uses updated limiter)
- `tests/unit/rate-limiter.test.ts` (update tests)

### End goal
Rate limiting is enforced only at the CLOB boundary with token bucket semantics.

### Acceptance criteria
- [ ] Token bucket correctly implements burst + sustained rate limiting
- [ ] Uses existing env keys (no new rate-limit vars)
- [ ] No double-throttling elsewhere in the pipeline
- [ ] Existing functionality unchanged (rate limits still enforced)
- [ ] Unit tests for refill and concurrent acquire behavior

---

## Task 3 — Expand Latency Stage Events + Overview Panel

### Reasoning
Cannot optimize what you cannot measure. Existing latency events and Overview SLOs already exist—extend them to cover more stages and surface in the existing dashboard.

### What to do
Emit additional latency stages using existing `latency` events and display them in `dashboard/src/pages/Overview.tsx`.

### How
1. Emit `latency` events for new stages:
   - `gated` (after `evaluateGates` passes in `Supervisor`)
   - `risk_approved` (after `RiskAgent` approves in `Supervisor`)
   - `complete` (after execution completes)
2. Keep existing `detected/submitted/acked/filled` events in `ExecutionAgent`.
3. Extend SLO aggregates to compute p95 latency for at least one additional stage (e.g., `acked` or `filled`).
4. Surface the new latency metric(s) in `dashboard/src/pages/Overview.tsx` (extend the SLO table).

### Files impacted
- `src/core/Supervisor.ts` (emit `gated`, `risk_approved`)
- `src/agents/execution/ExecutionAgent.ts` (emit `complete` if missing)
- `src/agents/ops/sloAggregates.ts` (compute additional stage p95)
- `src/api/server.ts` (return extended SLO response)
- `dashboard/src/pages/Overview.tsx` (display new latency p95)

### End goal
Granular latency visibility using the existing telemetry pipeline and Overview page.

### Acceptance criteria
- [ ] Timing recorded for: detection → gates → risk → submit → ack → fill → complete
- [ ] SLO aggregates include at least one additional stage latency p95
- [ ] Overview page shows stage latency p95 values
- [ ] No material performance impact from instrumentation

---

## Task 4 — Implement Tiered Edge Strategy

### Reasoning
User accepts 2% edge opportunities with 25% normal sizing and stricter gates. This expands opportunity set while maintaining EV-positive trades.

### What to do
Add tiered edge configuration and gate adjustment logic.

### How
1. Define edge tiers in `policy.ts`:
```typescript
export interface EdgeTier {
  id: string;
  minEdge: number;
  maxEdge: number;
  sizeFraction: number;  // fraction of normal size
  gates: Partial<TradePolicy>;  // gate overrides
}

export const DEFAULT_EDGE_TIERS: EdgeTier[] = [
  {
    id: 'high_confidence',
    minEdge: 0.05,
    maxEdge: 1.0,
    sizeFraction: 1.0,
    gates: {}  // use default gates
  },
  {
    id: 'standard',
    minEdge: 0.03,
    maxEdge: 0.05,
    sizeFraction: 0.5,
    gates: {}  // use default gates
  },
  {
    id: 'low_edge',
    minEdge: 0.02,
    maxEdge: 0.03,
    sizeFraction: 0.25,
    gates: {
      topOfBookStabilityMs: 500,      // stricter: 250 → 500
      depthBufferMultiplier: 2.0,     // stricter: 1.5 → 2.0
      minDepthLevels: 5,              // stricter: 3 → 5
      orderbookFreshnessMs: 300,      // stricter: 500 → 300
    }
  }
];
```

2. Update `gates.ts` to select tier based on detected edge:
```typescript
export function selectEdgeTier(edge: number, tiers: EdgeTier[]): EdgeTier | null {
  return tiers.find(t => edge >= t.minEdge && edge < t.maxEdge) ?? null;
}

export function applyTierGates(basePolicy: TradePolicy, tier: EdgeTier): TradePolicy {
  return { ...basePolicy, ...tier.gates };
}
```

3. Update `RiskAgent` to apply tier sizing

4. Add tier information to opportunity and execution events

### Files impacted
- `src/config/policy.ts` (add EdgeTier interface and defaults)
- `src/domain/gates.ts` (add tier selection and gate merging)
- `src/agents/risk/RiskAgent.ts` (apply tier sizing)
- `src/domain/types.ts` (add tier to Opportunity type)
- `tests/unit/gates.test.ts` (add tier tests)

### End goal
System captures 2-3% edge opportunities with appropriate risk-adjusted sizing.

### Acceptance criteria
- [ ] Three tiers defined: high_confidence (5%+), standard (3-5%), low_edge (2-3%)
- [ ] Low-edge tier uses stricter gates (stability, depth, freshness)
- [ ] Low-edge tier uses 25% of normal sizing
- [ ] Tier selection logged with each opportunity
- [ ] EV calculation still positive for all tiers
- [ ] Configurable via policy (can disable tiers)

---

## Task 5 — Align Velocity Control with CLOB Limiter

### Reasoning
ExecutionAgent currently enforces a velocity gate while CLOB has its own limiter. Consolidate throttling at the CLOB boundary and tune existing limits with a safety margin.

### What to do
Remove ExecutionAgent velocity gating and rely on the CLOB token bucket limiter for throughput.

### How
1. Remove the `velocity_throttle` gate in `ExecutionAgent` (keep OTR/delayed-ack gates).
2. Tune `POLYMARKET_CLOB_RATE_LIMIT_PER_SEC` and `POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS` for a conservative sustained rate (e.g., 5/sec) with token bucket bursts.
3. Keep velocity metrics (`order_attempt`) for monitoring but avoid blocking at the agent layer.

### Files impacted
- `src/agents/execution/ExecutionAgent.ts` (remove velocity gate)
- `src/services/RateLimiter.ts` (token bucket limiter)
- `tests/unit/execution.test.ts` (update throttle test expectations)

### End goal
Velocity is governed solely by the CLOB token bucket limiter, avoiding double-throttling.

### Acceptance criteria
- [ ] `ExecutionAgent` no longer blocks on `velocity_throttle`
- [ ] CLOB limiter enforces sustained rate with burst capacity
- [ ] Throughput tunable via existing env vars
- [ ] OTR and delayed-ack gates still enforced

---

## Task 6 — Global Concurrency + Capital Caps

### Reasoning
Per-market gating already exists. Add global caps for concurrent markets and capital in flight without introducing a new orchestrator.

### What to do
Add global concurrency and capital-in-flight caps inside `Supervisor`.

### How
1. Add `maxConcurrentMarkets` and `maxCapitalInFlight` to `SupervisorConfig`.
2. Track `capitalInFlight` and enforce caps before invoking `execution.executeArbitrage`.
3. Add env config:
```typescript
MAX_CONCURRENT_MARKETS: z.coerce.number().int().positive().default(3),
MAX_CAPITAL_IN_FLIGHT: z.coerce.number().int().positive().default(1000),
```
4. Record gate rejections for `max_concurrent_markets` and `capital_in_flight`.

### Files impacted
- `src/core/Supervisor.ts` (global caps and gating)
- `src/config/env.ts` (add config)
- `src/main.ts` (pass config to Supervisor)
- `tests/unit/supervisor.test.ts` (new or update)

### End goal
Execute across markets with global caps, preserving per-market isolation.

### Acceptance criteria
- [ ] Max concurrent markets enforced (configurable)
- [ ] Max capital in flight enforced (configurable)
- [ ] No same-market concurrent executions
- [ ] Each market isolated (failure in one doesn't affect others)
- [ ] Gate rejections recorded for global caps

---

## File-by-file implementation sequence

1. `src/services/RateLimiter.ts` — Task 2 (token bucket semantics)
2. `src/services/PolymarketClob.ts` — Task 1/2 (batch orders, consolidated limiter)
3. `src/services/PolymarketDataApi.ts` — Task 2 (consolidated limiter)
4. `src/config/policy.ts` — Task 4 (tiers)
5. `src/domain/gates.ts` — Task 4 (tier selection)
6. `src/domain/opportunity.ts` — Task 4 (tier metadata)
7. `src/agents/risk/RiskAgent.ts` — Task 4 (tier sizing)
8. `src/agents/execution/ExecutionAgent.ts` — Tasks 1, 3, 5 (batch, latency stages, remove velocity gate)
9. `src/config/env.ts` — Task 6 (global caps)
10. `src/main.ts` — Task 6 (pass caps to Supervisor)
11. `src/core/Supervisor.ts` — Tasks 3, 6 (latency stages, global caps)
12. `src/agents/ops/sloAggregates.ts` — Task 3 (additional stage p95)
13. `src/api/server.ts` — Task 3 (extend SLO response)
14. `dashboard/src/pages/Overview.tsx` — Task 3 (display new p95)
15. `tests/*` — All tasks (updated tests)

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| None required | — | All changes use existing dependencies |

---

## Near-Zero Risk Preservation Checklist

For each task, verify:

- [x] **No new inventory exposure** — All positions still complete sets or immediately unwindable
- [x] **Failure playbook unchanged** — Partial fills still trigger cancel + unwind
- [x] **Edge pays for failures** — EV formula still positive for all tiers
- [x] **Kill switches intact** — Trading can be disabled instantly
- [x] **Per-market isolation** — Circuit breakers still quarantine failing markets
- [x] **Deterministic timeouts** — No hanging orders or undefined states

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-11 | Initial plan with 6 tasks |
