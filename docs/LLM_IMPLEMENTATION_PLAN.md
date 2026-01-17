# LLM Implementation Plan (Condensed)

This is the condensed, minimal-risk implementation checklist. The detailed task-by-task plan lives in `docs/LLM_INTEGRATION_PLAN.md`.

Goal: add strictly-advisory LLM capabilities while preserving deterministic gates, limits, and the execution state machine.

---

## Overview

### Scope
- Add an OpenAI-compatible LLM provider abstraction with primary/fallback routing (OpenCode Zen + OpenRouter).
- Enable online learning via LearningAgent with persisted decisions and publishable insights.
- Integrate LLM advisory logic into all seven agents without relaxing deterministic gates.
- Maintain env-only configuration; no UI controls for LLM infra.

### Key decisions
- LLM outputs are advisory; deterministic logic remains the final authority.
- ExecutionAgent uses cached/advisory LLM hints only; no blocking calls on the hot path.
- Use existing `RetryPolicy` and `CircuitBreaker` utilities for resilience.
- Persist LLM decisions in the existing `decisions` table for auditability (store richer payloads inside JSON; avoid schema migrations by default).
- Add global kill switches, but default them on for launch: `LLM_ENABLED=true` and `LLM_DATA_EXPORT_ENABLED=true` (runtime still requires at least one API key).

### Hard constraints (non-negotiable)
- LLMs never place/cancel orders or bypass `src/domain/gates.ts`; outputs are untrusted data that must be schema-validated + bounded.
- Any trade-impacting feature starts in shadow mode before advisory; LLM can only make behavior more conservative (no increased risk).

---

## Task 1 — Add LLM env config and policy module

### Reasoning
LLM settings must be env-only to avoid UI drift and to follow current configuration patterns.

### What to do
Introduce env-validated LLM configuration and a derived LLM policy module.

### How
1. Extend `envSchema` with LLM provider/model/timeouts/retry/circuit knobs.
2. Add `src/config/llm.ts` to normalize env into a typed LLM config used by services/agents.
3. Update `.env.example` with all new keys (dashboard remains infra-read-only; no LLM knobs in UI).

### Files impacted
- `src/config/env.ts`
- `src/config/llm.ts` (new file)
- `.env.example`

### End goal
LLM configuration is validated at startup and available as a typed config object.

### Acceptance criteria
- [ ] Startup fails on invalid LLM env configuration.
- [ ] All LLM env keys appear in `.env.example`.

---

## Task 2 — Implement LLM provider abstraction with failover + resilience

### Reasoning
A shared LLM client must support OpenAI-compatible APIs, retries, circuit breakers, and low-latency timeouts.

### What to do
Build a provider-agnostic LLM client with primary/fallback routing.

### How
1. Add `src/services/llm/` with:
   - `LLMClient` interface and typed request/response contracts.
   - `OpenAISdkClient` using the official `openai` Node SDK (supports `baseURL`, `defaultHeaders`, `timeout`, `maxRetries`; capture request IDs via SDK `_request_id` when present and/or provider `request_id` fields in response bodies).
   - `LLMRouter` to choose primary/fallback providers per request.
2. Use OpenAI SDK `timeout` + `maxRetries` (keep retries conservative) and wrap with `CircuitBreaker` for failover safety.
3. Emit metrics for latency, timeout, error rate, and fallback usage.
4. (Optional) Add response caching later if needed; keep v1 minimal to reduce drift.

### Files impacted
- `src/services/llm/LLMClient.ts` (new file)
- `src/services/llm/OpenAISdkClient.ts` (new file)
- `src/services/llm/LLMRouter.ts` (new file)
- `src/services/llm/types.ts` (new file)
- `src/telemetry/metrics.ts` (add LLM metric types)

### End goal
LLM requests are resilient, observable, and safely routed between providers.

### Acceptance criteria
- [ ] Requests fail fast on timeout and fall back to secondary provider when enabled.
- [ ] Circuit breaker opens after configured failures and recovers in half-open mode.
- [ ] LLM metrics are emitted for latency and error tracking.

---

## Task 3 — Persist LLM decisions and publish LLM events

### Reasoning
Decisions must be auditable and replayable to support online learning and policy analysis.

### What to do
Add EventStore helpers and MessageBus events for LLM decisions and insights.

### How
1. Add `persistDecision()` and `listDecisions()` methods to `EventStore`.
2. Define `LLMDecisionRecordV1` and write **one row per LLM call**:
   - `decision_json`: bounded output actually consumed (post-validate/post-clamp), deterministic `baseline`, `task`, `mode`, `confidence`, `applied`, `clamp` details.
   - `reasoning_json`: provider+model+endpoint, request IDs (`_request_id` header when present + provider body IDs), timing (`latency_ms`, `timeout_ms`), params, hashes, token usage, status/error, policy hashes.
   - Note: `decisions.opportunity_id` is required today — treat it as a generic subject id (opportunity id, market id, or `system:*`).
3. Emit new events: `llm:decision`, `learning:insight`, `learning:update` via MessageBus (MessageBus is stringly-typed; document payloads in `src/domain/llm.ts`).

### Files impacted
- `src/core/EventStore.ts`
- `src/domain/llm.ts` (new file)

### End goal
LLM decisions and insights are persisted and replayable for analysis.

### Acceptance criteria
- [ ] LLM decisions are written to `decisions` table with consistent schema.
- [ ] New LLM events are emitted without breaking existing subscribers.

---

## Task 4 — Upgrade LearningAgent to an online learning loop

### Reasoning
LearningAgent is the feedback loop to transform raw events into actionable insights.

### What to do
Extend LearningAgent to aggregate outcomes and produce insights via LLM summarization.

### How
1. Subscribe to execution and portfolio events (fills, outcomes, incidents, rejections).
2. Maintain rolling aggregates per market (win rate, slippage, timeout rate, drift rate).
3. Periodically call LLM to summarize patterns and output `learning:insight` events.
4. Persist insights to `decisions` table with `agent = LearningAgent`.

### Files impacted
- `src/agents/learning/LearningAgent.ts`
- `src/domain/llm.ts`
- `src/core/EventStore.ts`

### End goal
A continuous learning loop produces insights for other agents without blocking execution.

### Acceptance criteria
- [ ] LearningAgent publishes insights on schedule and on key triggers.
- [ ] Insights are cached and replayable from EventStore.

---

## Task 5 — ScannerAgent LLM prioritization

### Reasoning
ScannerAgent benefits from learned market prioritization without altering gate logic.

### What to do
Use learning insights and LLM scoring to prioritize opportunities.

### How
1. Add a `MarketPriorityCache` populated by LearningAgent insights.
2. Incorporate priority score in `Supervisor` scan ordering (no change to gate checks).
3. Add optional LLM scoring in shadow mode to compare against deterministic ordering.

### Files impacted
- `src/agents/scanner/ScannerAgent.ts`
- `src/core/Supervisor.ts`
- `src/agents/learning/LearningAgent.ts`

### End goal
ScannerAgent can prioritize markets based on LLM-informed signals while still enforcing gates.

### Acceptance criteria
- [ ] Gate checks remain unchanged for all opportunities.
- [ ] Priority scores are optional and default to neutral when missing.

---

## Task 6 — RiskAgent LLM sizing advisor

### Reasoning
RiskAgent can become more conservative (smaller size) based on recent outcomes without ever increasing exposure beyond deterministic limits.

### What to do
Add an LLM sizing advisor that can only recommend a **conservative** size (≤ deterministic size). Start in shadow mode; only apply in advisory mode.

### How
1. Create `RiskAdvisor` to request a recommended size within `[minOrderSize, deterministicSize]` (no up-sizing).
2. Shadow mode: validate + clamp + record recommendation, but do not apply it.
3. Advisory mode: apply the clamped recommendation; fallback to deterministic sizing on invalid/late output.
4. Persist decisions and publish `llm:decision` for auditability.

### Files impacted
- `src/agents/risk/RiskAgent.ts`
- `src/agents/risk/RiskAdvisor.ts` (new file)
- `src/domain/llm.ts`
- `src/core/EventStore.ts`

### End goal
LLM can only reduce sizing (never increase) while preserving deterministic constraints.

### Acceptance criteria
- [ ] LLM sizing never exceeds deterministic bounds (no up-sizing).
- [ ] Shadow mode produces logs/metrics but does not change behavior.
- [ ] Any invalid or late LLM response falls back to deterministic sizing.

---

## Task 7 — ExecutionAgent advisory integration

### Reasoning
Execution decisions are latency-critical; LLM can only provide advisory hints and post-trade analysis.

### What to do
Add a non-blocking advisory loop for execution strategy hints.

### How
1. Add `ExecutionAdvisor` to generate bounded recommendations (timeouts, unwind strategy) from recent outcomes.
2. Shadow mode: compute + record hints but do not apply.
3. Advisory mode: apply hints only at trade setup and only within conservative bounds (no longer timeouts / no relaxed unwinds).
4. Never call LLM on the hot path; use cached insights and async updates.

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/execution/ExecutionAdvisor.ts` (new file)
- `src/config/llm.ts`
- `src/domain/llm.ts`

### End goal
ExecutionAgent remains deterministic and fast while benefiting from LLM guidance.

### Acceptance criteria
- [ ] Execution path remains non-blocking with <100ms decision latency.
- [ ] LLM recommendations are advisory and bounded by config.

---

## Task 8 — Portfolio/MarketData/Ops LLM insights

### Reasoning
These agents can benefit from anomaly detection and predictive alerts without affecting trades.

### What to do
Add non-blocking LLM insights to PortfolioAgent, MarketDataAgent, and OpsAgent.

### How
1. PortfolioAgent: detect reconciliation anomalies and publish `ops:alert` when confidence is high.
2. MarketDataAgent: flag outlier price moves or stale feeds for ops visibility.
3. OpsAgent: use LLM to summarize health trends and forecast incident risk.

### Files impacted
- `src/agents/portfolio/PortfolioAgent.ts`
- `src/agents/market-data/MarketDataAgent.ts`
- `src/agents/ops/OpsAgent.ts`
- `src/domain/llm.ts`

### End goal
LLM adds visibility without altering deterministic trade decisions.

### Acceptance criteria
- [ ] Alerts are advisory and never block trading.
- [ ] Anomaly detection can be disabled via env.

---

## Task 9 — Testing + phased rollout

### Reasoning
Coverage and safety gates must remain intact while LLMs are introduced.

### What to do
Add mocks, shadow-mode tests, and a phased rollout strategy.

### How
1. Implement `MockLLMClient` with deterministic fixtures and failure scenarios.
2. Add unit tests for each advisor to verify clamping, fallback, and timeouts.
3. Add integration tests to validate that deterministic gates still reject invalid trades.
4. Roll out in phases: LearningAgent(active) -> Scanner(shadow→advisory) -> Risk(shadow→advisory, conservative-only) -> Execution(shadow→advisory, cached hints) -> Portfolio/MarketData/Ops(advisory).

### Files impacted
- `tests/unit/llm/*.test.ts` (new files)
- `tests/integration/llm-shadow-flow.test.ts` (new file)
- `src/services/llm/MockLLMClient.ts` (new file)

### End goal
LLM integration is safe, testable, and rolled out in controlled stages.

### Acceptance criteria
- [ ] Tests cover timeout, retry, and fallback paths.
- [ ] Coverage remains >= 95%.
- [ ] Rollout can be enabled per agent via env flags.

---

## File-by-file implementation sequence

1. `package.json` — add `openai`
2. `src/config/env.ts` — Task 1
3. `src/config/llm.ts` — Task 1 (new file)
4. `src/services/llm/*` — Task 2 (new files)
5. `src/domain/llm.ts` — Task 3 (new file)
6. `src/core/EventStore.ts` — Task 3
7. `src/agents/learning/LearningAgent.ts` — Task 4
8. `src/agents/scanner/ScannerAgent.ts` — Task 5
9. `src/agents/risk/RiskAgent.ts` + `src/agents/risk/RiskAdvisor.ts` — Task 6
10. `src/agents/execution/ExecutionAgent.ts` + `src/agents/execution/ExecutionAdvisor.ts` — Task 7
11. `src/agents/portfolio/PortfolioAgent.ts` + `src/agents/market-data/MarketDataAgent.ts` + `src/agents/ops/OpsAgent.ts` — Task 8
12. `tests/**` — Task 9

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| `openai` | `^4.x` | Official OpenAI Node SDK for OpenAI-compatible providers |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-05 | Initial plan |
