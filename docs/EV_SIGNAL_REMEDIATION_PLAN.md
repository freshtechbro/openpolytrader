# EV Signal Remediation Plan

Plan to remediate EV signal correctness, fill tracking, risk caps visibility, and web-search pipeline reliability with minimal, high-impact changes.

---

## Overview

### Scope
- EV signal math + gates, execution fill tracking, and risk caps.
- Web-search signal ingestion (cache safety, provider separation, bounded concurrency).
- Tests + docs updates to lock behaviors.

### Key decisions
- Keep EV portfolio caps scoped to total exposure (conservative, smallest change); clarify via constraints + docs.
- Require user WS for EV trades (or block) to keep fills/portfolio/OTR correct.
- Add explicit `evFeeBps` to policy and include in EV net.

---

## Task 1 — Require EV user-channel fills + record fills for OTR

### Reasoning
EV trades currently run without user WS fill tracking, which can desync portfolio state and inflate OTR metrics.

### What to do
Require user WS for EV and record fills for EV orders using the same fill timeout flow.

### How
1. In `ExecutionAgent.executeArbitrage`, set `requiresUserChannel` to include EV opportunities.
2. In `executeEvOrder`, after ack + `orderId`, call `waitForFillOutcome` (if configured) and record fills/latencies on success; on timeout/partial, record incidents and return failure.
3. Ensure idempotency record status updates to `confirmed` on EV fill.
4. Add tests for EV blocking when user WS missing/disconnected and EV fill/OTR metrics.

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `tests/unit/ev_signal.test.ts`
- `tests/unit/execution.test.ts`

### End goal
EV orders are only placed when fill tracking is available, and EV fills update metrics and portfolio reliably.

### Acceptance criteria
- [ ] EV trade is blocked when user WS is unconfigured/disconnected
- [ ] EV order records fill and latency metrics on success
- [ ] EV order failure/timeout generates incidents and does not inflate OTR

---

## Task 2 — Apply fees to EV net + EV gate safety

### Reasoning
EV net currently ignores fees and EV gates do not enforce tick-based thresholds or finite inputs.

### What to do
Add `evFeeBps` to policy and incorporate into `evNet`; enforce finite EV inputs and tick/max-edge checks.

### How
1. Add `evFeeBps` to `TradePolicy`, defaults, and schema validation.
2. Update `buildEvOpportunity` to compute `evNet = evRaw - evFeeBps/10000 - slippageEstimate`.
3. In `evaluateEvGates`, reject non-finite `evEdge`/`confidence` and enforce `minEdgeTicks` and `maxEdge` like non‑EV gates.
4. Update EV signal tests to cover fee adjustments, NaN/Inf edges, and tick/max-edge enforcement.

### Files impacted
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`
- `src/agents/scanner/ScannerAgent.ts`
- `src/domain/gates.ts`
- `tests/unit/ev_signal.test.ts`
- `tests/unit/gates.test.ts`

### End goal
EV edge is fee-adjusted and gates are robust to malformed inputs and extreme edges.

### Acceptance criteria
- [ ] EV net includes fees and slippage in all EV decisions
- [ ] EV gates reject NaN/Inf values and enforce tick/max-edge constraints
- [ ] Tests cover fee-adjusted EV net and gate thresholds

---

## Task 3 — EV caps observability + documentation clarity

### Reasoning
EV caps are enforced but not visible in constraint binding, and scope (total exposure vs EV-only) is undocumented.

### What to do
Expose EV cap constraints in risk decisions and document that caps apply to total exposure.

### How
1. Add EV cap values to `constraints` and `binding` when they are the limiting factor.
2. Update EV spec to clarify EV cap semantics (total exposure across all positions).

### Files impacted
- `src/agents/risk/RiskAgent.ts`
- `docs/EV_SIGNAL_SPEC.md`

### End goal
EV cap decisions are observable and documented.

### Acceptance criteria
- [ ] Risk decision contains EV cap constraints and binding when triggered
- [ ] EV spec explicitly states cap scope

---

## Task 4 — Web-search cache safety + provider separation

### Reasoning
Cache growth is unbounded and provider results can contaminate each other if keys collide.

### What to do
Add cache size limits and provider-prefixed keys; prune on insert.

### How
1. Extend `WebSearchCache` to accept max entries and prune expired/oldest on insert.
2. Prefix cache keys with provider ID (`exa:` / `firecrawl:`) in both clients.
3. Add tests for cache TTL eviction and provider isolation.

### Files impacted
- `src/services/websearch/WebSearchCache.ts`
- `src/services/websearch/ExaClient.ts`
- `src/services/websearch/FirecrawlClient.ts`
- `tests/unit/websearch_cache.test.ts` (new file)

### End goal
Web-search cache is bounded and provider data is isolated.

### Acceptance criteria
- [ ] Cache does not grow unbounded for unique queries/URLs
- [ ] Provider A never reuses provider B’s cached data
- [ ] Tests cover TTL eviction and provider prefixing

---

## Task 5 — Bounded concurrency + Firecrawl crawl limits

### Reasoning
Signal aggregation is serial under a global lock and Firecrawl crawl fallback can be expensive.

### What to do
Introduce a small concurrency pool and add crawl limits to Firecrawl requests.

### How
1. Add a small utility (e.g., `runWithConcurrency`) to process market queries with a fixed limit.
2. Add policy config for `evWebSearchMaxConcurrency` and Firecrawl crawl caps (max pages/depth).
3. Update `SignalAggregatorAgent.runOnce` and `fetchSignals` to use bounded concurrency.
4. Update Firecrawl client to pass crawl limits to the API.

### Files impacted
- `src/utils/concurrency.ts` (new file)
- `src/agents/signal/SignalAggregatorAgent.ts`
- `src/services/websearch/FirecrawlClient.ts`
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`

### End goal
Signal ingestion stays within resource bounds and refresh cadence is predictable.

### Acceptance criteria
- [ ] Search/crawl tasks run with bounded concurrency
- [ ] Firecrawl crawl requests enforce max depth/pages
- [ ] Policy validation covers new fields

---

## Task 6 — Extend EV pipeline tests

### Reasoning
Current tests do not cover EV execution fill tracking, EV gate edge ticks, or EV cap binding.

### What to do
Add targeted unit tests for EV execution, gates, and risk caps.

### How
1. Add EV execution tests for user-channel requirements and fill timeouts.
2. Add EV gates tests for fee-adjusted edges, tick/min-edge, and finite checks.
3. Add EV cap tests ensuring `evMaxPerMarketNotional` and `evMaxPortfolioNotional` are enforced and reflected in constraints.

### Files impacted
- `tests/unit/execution.test.ts`
- `tests/unit/gates.test.ts`
- `tests/unit/risk.test.ts`

### End goal
EV pipeline behavior is test-protected.

### Acceptance criteria
- [ ] EV execution tests pass for user-channel and fill scenarios
- [ ] EV gate tests pass for fee and tick constraints
- [ ] EV risk cap tests cover per-market and portfolio caps

---

## Task 7 — Documentation updates

### Reasoning
Specs and operator docs should reflect EV fee inputs, WS requirements, and cache limits.

### What to do
Update EV spec and config documentation to match new behavior.

### How
1. Update `docs/EV_SIGNAL_SPEC.md` for `evFeeBps`, user WS requirement, and cache limits.
2. Add config schema notes for new fields.

### Files impacted
- `docs/EV_SIGNAL_SPEC.md`
- `docs/ARCHITECTURE.md`

### End goal
Docs reflect the implemented EV pipeline behavior.

### Acceptance criteria
- [ ] EV spec matches code behavior and config fields
- [ ] Architecture docs describe signal ingestion limits

---

## File-by-file implementation sequence

1. `src/agents/execution/ExecutionAgent.ts` — Task 1
2. `src/agents/scanner/ScannerAgent.ts` — Task 2
3. `src/domain/gates.ts` — Task 2
4. `src/agents/risk/RiskAgent.ts` — Task 3
5. `src/services/websearch/WebSearchCache.ts` — Task 4
6. `src/services/websearch/ExaClient.ts` — Task 4
7. `src/services/websearch/FirecrawlClient.ts` — Task 4/5
8. `src/agents/signal/SignalAggregatorAgent.ts` — Task 5
9. `src/config/policy.ts` + `src/config/schema.ts` + `src/config/validate.ts` — Tasks 2/5
10. `tests/unit/*` — Task 6
11. `docs/EV_SIGNAL_SPEC.md` + `docs/ARCHITECTURE.md` — Task 7

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| (none) | | Use local concurrency helper to avoid new deps |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-31 | Initial plan |
