# EV Signal + Web Search Integration Plan

Full implementation plan for EV (model-based) signal path plus direct API integration for Exa (default) and optional Firecrawl.

---

## Overview

### Scope
- Add EV signal generation alongside near-zero arbitrage.
- Integrate web-search ingestion (Exa default, Firecrawl optional) via direct HTTP APIs.
- Provide config/observability, caching, and tests.

### Key decisions
- Direct API integration is the production path; MCP is optional for ad-hoc enrichment.
- Exa enabled by default, Firecrawl disabled by default.
- Use in-memory TTL caching initially to control cost and latency.

---

## Task 1 — EV + Web Search Configuration Wiring

### Reasoning
EV mode and web-search ingestion require explicit configuration, safe defaults, and documentation for operators.

### What to do
Add config schemas, env vars, and policy defaults for EV and web-search controls.

### How
1. Extend config schema to include EV settings and web-search controls.
2. Add env variables (EXA_API_KEY, FIRECRAWL_API_KEY) and rate-limit knobs.
3. Document defaults and validation rules.

### Files impacted
- `src/config/env.ts`
- `src/config/schema.ts`
- `src/config/policy.ts`
- `.env.example`
- `docs/Operations/config-knobs.md`

### End goal
Operators can enable EV mode and web-search ingestion safely with explicit defaults and validation.

### Acceptance criteria
- [ ] EV and web-search knobs appear in config schema with sane defaults.
- [ ] `.env.example` includes required API keys with guidance.
- [ ] Config docs list every new knob and default value.

---

## Task 2 — Web Search Clients (Exa + Firecrawl) with Caching

### Reasoning
We need a cost-controlled, rate-limited ingestion layer to fetch and normalize web sources.

### What to do
Implement Exa and Firecrawl clients with a shared interface, TTL caching, and rate limiting.

### How
1. Add `WebSearchClient` interface with `search(query)` and `fetchContents(urls)`.
2. Implement `ExaClient` using /search + /contents endpoints.
3. Implement `FirecrawlClient` for /search and /scrape (and /crawl only if explicitly enabled).
4. Add an in-memory TTL cache keyed by query+url to avoid repeated fetches.
5. Use existing `RateLimiter` to enforce per-minute caps.

### Files impacted
- `src/services/websearch/WebSearchClient.ts` (new file)
- `src/services/websearch/ExaClient.ts` (new file)
- `src/services/websearch/FirecrawlClient.ts` (new file)
- `src/services/websearch/WebSearchCache.ts` (new file)
- `src/services/RateLimiter.ts` (reuse)

### End goal
A direct API ingestion layer with caching and rate limits, Exa default, Firecrawl optional.

### Acceptance criteria
- [ ] Exa and Firecrawl requests are rate-limited and keyed by config.
- [ ] Cache hits prevent repeat fetches within TTL.
- [ ] Exa-only path works without Firecrawl enabled.

---

## Task 3 — Signal Aggregator Agent (Web Search -> Features)

### Reasoning
Signals need structured features to feed EV modeling and should not be embedded in the scanner.

### What to do
Create a Signal Aggregator Agent that performs web-search ingestion and emits normalized features per market.

### How
1. Create `SignalAggregatorAgent` that builds queries from market metadata (question, outcomes, tags).
2. Run Exa search + contents; optionally enrich with Firecrawl if enabled and needed.
3. Normalize outputs (entities, recency, source credibility) into feature vectors.
4. Emit `learning:insight`-compatible events on the message bus.

### Files impacted
- `src/agents/signal/SignalAggregatorAgent.ts` (new file)
- `src/core/Supervisor.ts` (wire agent lifecycle)
- `src/core/MessageBus.ts` (new event typings, if needed)
- `src/domain/llm.ts` (schema for insight payloads, if needed)

### End goal
A standalone agent that produces structured web-search insights without coupling to scanner logic.

### Acceptance criteria
- [ ] Agent emits insights with TTL and confidence for target markets.
- [ ] Supervisor can start/stop the agent cleanly.
- [ ] Insights are consumable by `ScannerAgent` (existing flow).

---

## Task 4 — EV Opportunity Path + Gating

### Reasoning
EV mode must be integrated into the existing decision chain with the same safety gates.

### What to do
Implement EV opportunity generation and feed it into the risk + execution pipeline.

### How
1. Extend `ArbitrageOpportunity` (or add a new EV opportunity type) with model probability, EV estimate, and confidence.
2. Create EV opportunity generation logic using `p_final` and current asks (yes/no).
3. Apply EV-specific gates (evEdgeRequired, evConfidenceMin, caps).
4. Route EV opportunities through existing gate evaluation, risk evaluation, and execution.

### Files impacted
- `src/domain/opportunity.ts`
- `src/agents/scanner/ScannerAgent.ts`
- `src/domain/gates.ts`
- `src/agents/risk/RiskAgent.ts`
- `src/core/Supervisor.ts`

### End goal
EV opportunities can be produced, gated, and passed into risk/execution without bypassing safety checks.

### Acceptance criteria
- [ ] EV opportunities appear when signalMode is `ev` or `both`.
- [ ] EV opportunities are rejected with explicit reasons when below thresholds.
- [ ] Existing near-zero logic remains unchanged.

---

## Task 5 — Metrics, Logging, and Tests

### Reasoning
We need visibility into EV behavior and web-search ingestion plus regression coverage.

### What to do
Add metrics, logs, and tests for web-search ingestion and EV opportunity gating.

### How
1. Add metrics for web-search requests, cache hits, failures, and latency.
2. Add EV metrics for decision rates and rejection reasons.
3. Add unit tests for Exa/Firecrawl client request shaping and caching.
4. Add unit tests for EV opportunity generation and gating.

### Files impacted
- `src/telemetry/events.ts`
- `src/telemetry/metrics.ts`
- `tests/unit/websearch.test.ts` (new file)
- `tests/unit/ev_signal.test.ts` (new file)

### End goal
Observable, tested EV and web-search pipelines with clear failure signals.

### Acceptance criteria
- [ ] Metrics emit for web-search and EV decisions.
- [ ] Tests cover cache behavior and EV gating.
- [ ] `npm test` passes with new coverage.

---

## File-by-file implementation sequence
1. `src/config/env.ts` — Task 1
2. `src/config/schema.ts` — Task 1
3. `src/config/policy.ts` — Task 1
4. `src/services/websearch/WebSearchClient.ts` — Task 2
5. `src/services/websearch/ExaClient.ts` — Task 2
6. `src/services/websearch/FirecrawlClient.ts` — Task 2
7. `src/services/websearch/WebSearchCache.ts` — Task 2
8. `src/agents/signal/SignalAggregatorAgent.ts` — Task 3
9. `src/core/Supervisor.ts` — Task 3
10. `src/domain/opportunity.ts` — Task 4
11. `src/agents/scanner/ScannerAgent.ts` — Task 4
12. `src/domain/gates.ts` — Task 4
13. `src/agents/risk/RiskAgent.ts` — Task 4
14. `src/telemetry/events.ts` — Task 5
15. `src/telemetry/metrics.ts` — Task 5
16. `tests/unit/websearch.test.ts` — Task 5
17. `tests/unit/ev_signal.test.ts` — Task 5

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| (none) | | Use built-in fetch + existing RateLimiter |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-30 | Initial plan for EV signal + Exa/Firecrawl integration |
