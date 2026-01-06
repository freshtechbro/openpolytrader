# LLM Integration Plan — AI-Driven Multi-Agent System

**Generated:** 2026-01-05  
**Status:** Draft  
**Effort:** Large (1–2 weeks for safe phased rollout)

---

## Overview

Add optional, **strictly-advisory** LLM capabilities to all 7 agents while preserving deterministic TypeScript behavior, gates, and the execution state machine. LearningAgent provides an **online insight loop** (synthesis of outcomes into bounded hints), but **no LLM output may directly trigger orders or modify policy**.

### Core Principles
1. **LLMs are ADVISORY, not authoritative** — deterministic gates always enforced
2. **Insights update continuously** — LearningAgent aggregates outcomes and publishes bounded insights (no finetuning)
3. **Execution stays FAST** — no LLM calls on hot path; use cached hints only
4. **Fail OPEN to deterministic** — LLM unavailable = fall back to existing logic
5. **Config is ENV-ONLY** — consistent with existing infra pattern

### Non-goals (Hard Constraints)
- **No autonomous trading actions**: LLMs never place/cancel orders, call venues, or bypass `src/domain/gates.ts`.
- **No runtime policy edits**: LLMs cannot modify `TradePolicy`/`RiskConfig` or any gate thresholds at runtime.
- **No hot-path dependence**: Execution state machine remains deterministic; any LLM-derived hint must be cached and optional.
- **Outputs treated as untrusted**: every output must be schema-validated, bounded/clamped, and safely ignorable.
- **No secrets in/out**: never include API keys/private material in prompts, logs, telemetry, or decision persistence.
- **Untrusted text is data-only**: external strings (e.g., market question/outcome names) are tainted; either omit or strictly delimit as data (prompt-injection resistant).

### Security & Data Governance (Must-Haves)
- **Data minimization (recommended)**: prefer aggregated numeric features over raw orderbooks/positions to reduce latency/cost and prompt-injection surface area.
- **Data export allowed (per policy)**: portfolio/orderbook/trade details may be sent to third-party LLMs, but **secret keys must never be included** (redact as a hard requirement).
- **Prompt-injection posture**: separate instructions from data; sanitize/limit external strings; validate outputs (OWASP LLM prompt injection guidance).
- **Decision-store hygiene**: default to storing hashes + bounded structured outputs; add optional “full payload” mode only for local/dev.
- **Provider headers**: OpenRouter supports optional `HTTP-Referer` and `X-Title` headers for attribution; keep them configurable.

### Model Policy
| Agent | Model | Provider | Mode | Rationale |
|-------|-------|----------|------|-----------|
| ExecutionAgent | google/gemini-3-flash-preview | OpenRouter | shadow → advisory (cached; conservative-only) | Fast hint synthesis |
| RiskAgent | glm-4.7-free | OpenCode Zen | shadow → advisory (conservative-only) | Size reduction factor only |
| ScannerAgent | glm-4.7-free | OpenCode Zen | shadow → advisory | Priority scoring |
| LearningAgent | minimax/minimax-m2.1 | OpenRouter | active | Insight synthesis |
| PortfolioAgent | moonshotai/kimi-k2 | OpenRouter | advisory | Anomaly detection |
| MarketDataAgent | gpt-5-nano | OpenCode Zen | advisory | Outlier detection |
| OpsAgent | moonshotai/kimi-k2 | OpenRouter | advisory | Health summaries |

---

## Task 1 — LLM Configuration Module

### Reasoning
All LLM configuration must be env-only, matching the existing infra pattern from config-knobs.md.

### What to do
Create a typed LLM config module that loads provider settings, per-agent model assignments, and retry/circuit breaker parameters from environment variables.

### How
1. Create `src/config/llm.ts` with Zod schemas for LLM config
2. Define provider config (primary/fallback URLs, API keys)
3. Define per-agent config (model, mode, timeout)
   - Include per-agent provider preference (`LLM_<AGENT>_PROVIDER`) to allow mixing Zen/OpenRouter while still using OpenAI SDK
4. Define retry/circuit breaker settings
5. Update `.env.example` with all new variables
6. Export typed `LLMConfig` for use by LLM client

### Files impacted
- `src/config/llm.ts` (new file)
- `.env.example`

### End goal
All LLM configuration is typed, validated, and loaded from environment variables.

### Acceptance criteria
- [ ] `npm run typecheck` passes
- [ ] Config validates with Zod at startup
- [ ] Missing required keys throw clear errors
- [ ] Defaults are sensible (mode=disabled, timeout=500ms)

---

## Task 2 — LLM Client with Provider Abstraction

### Reasoning
Need a unified client that handles both OpenCode Zen and OpenRouter with automatic failover, retries, circuit breaker, and strict client-side timeouts.

### What to do
Implement an OpenAI-compatible LLM client using the official `openai` Node SDK, with provider failover, circuit breaker protection, and strict timeouts.

### How
1. Add dependency: `openai` (official Node SDK)
2. Create `src/services/llm/types.ts` with LLM request/response types + provider identifiers
3. Create `src/services/llm/OpenAISdkClient.ts`:
   - Instantiate `new OpenAI({ apiKey, baseURL, defaultHeaders, timeout, maxRetries })`
   - Use `client.chat.completions.create(...)` for OpenAI-compatible chat endpoints (Zen `/chat/completions`, OpenRouter `/chat/completions`)
   - Use `client.responses.create(...)` for Zen `/responses` models (eg `gpt-5-nano`)
   - **Auth**: OpenCode Zen is OpenAI-style; send `Authorization: Bearer <ZEN_API_KEY>` (treat missing/empty key as config error to avoid provider-side failures)
   - Capture request IDs for audit logging:
     - `x-request-id` via OpenAI SDK `_request_id` (when present)
     - Zen also returns `request_id` in the JSON body (record it as a fallback; headers may be absent)
4. Reuse `src/core/CircuitBreaker.ts` with an LLM-specific instance per provider (prevents cascading failures)
5. Create `src/services/llm/LLMRouter.ts` to select provider order per agent (eg Learning/Execution prefer OpenRouter; Scanner/Risk prefer Zen)
6. Create `src/services/llm/LLMClient.ts` as the main facade (routes, enforces per-agent timeout/maxRetries, persists decisions)
7. Add `src/services/llm/index.ts` barrel export

### Files impacted
- `src/services/llm/types.ts` (new file)
- `src/services/llm/LLMRouter.ts` (new file)
- `src/services/llm/LLMClient.ts` (new file)
- `src/services/llm/OpenAISdkClient.ts` (new file)
- `src/services/llm/index.ts` (new file)
- `package.json` (new dependency)

### End goal
A robust LLM client that uses the OpenAI SDK for OpenAI-compatible providers, with failover + circuit breaking and strict latency enforcement.

### Acceptance criteria
- [ ] Client works with both OpenCode Zen and OpenRouter endpoints
- [ ] Timeouts enforced via OpenAI SDK `timeout` (per-request override supported)
- [ ] Retries controlled via OpenAI SDK `maxRetries` (defaults conservative for near-zero-risk)
- [ ] Circuit breaker opens after N failures, half-opens after cooldown
- [ ] Fallback provider used when primary circuit is open
- [ ] Unit tests for all failure modes
- [ ] `npm run test` passes

---

## Task 3 — Decision Persistence and Events

### Reasoning
LLM decisions need to be persisted for learning and auditing. New event types enable the learning loop.

### What to do
Extend EventStore with decision persistence and add new LLM-related event types to MessageBus.

### How
1. Add `persistDecision()` and `listDecisions()` methods to EventStore
2. Define an `LLMDecisionRecordV1` schema (stored inside existing `decision_json`/`reasoning_json`) and write **one row per LLM call**.
   - **decision_json (bounded + agent-consumable)**: `schema_version`, `agent`, `mode`, `task`, `subject`, `baseline` (deterministic), `output` (post-validate/post-clamp), `confidence`, `applied`, `clamp` (raw/final/bounds/violations), `ttl_ms?`
   - **reasoning_json (audit envelope)**:
     - **provider**: `provider_id` (opencode-zen|openrouter), `base_url`, `endpoint` (chat.completions|responses), `model`
     - **request identity**: `request_id_header?` (SDK `_request_id`), `request_id_body?` (Zen `request_id`), `response_id?` (body `id`), `correlation_id?`, `attempt`, `fallback_reason?`
     - **timing**: `started_at_ms`, `latency_ms`, `timeout_ms`, `max_retries`
     - **params**: `temperature`, `top_p`, `max_output_tokens`, `response_format?`
     - **hashes**: `prompt_hash`, `context_hash`, `prompt_version`
     - **usage**: `input_tokens`, `output_tokens`, `total_tokens` (when provided)
     - **result**: `status` (success|fallback|timeout|error), `error` (type/status/message) when applicable
     - **policy snapshots**: `trade_policy_hash`, `risk_config_hash` (for drift-proofing)
     - **data export**: `included_trade_details` (allowed) + `redaction_applied` (must be true when prompts include any secret-like material)
3. **Avoid schema migrations by default**: `decisions` already exists (and requires `opportunity_id`), so treat it as a generic subject id (opportunity id, market id, or `system:*`). Only add migrations if you need indexed columns later.
4. Define and emit new MessageBus event **names** (MessageBus is currently stringly-typed): `llm:decision`, `llm:error`, `learning:insight`, `learning:update`
5. Emit `llm:decision` after every LLM call (success or fallback)

### Files impacted
- `src/core/EventStore.ts`
- `src/domain/llm.ts` (new file; Zod schemas + payload types)

### End goal
All LLM decisions are persisted and observable via MessageBus events.

### Acceptance criteria
- [ ] Decisions stored in SQLite `decisions` table
- [ ] `listDecisions()` supports filtering by agent, time range
- [ ] New event payloads are schema-defined (Zod) and emittable
- [ ] Unit tests for decision persistence
- [ ] `npm run test` passes

---

## Task 4 — LearningAgent Online Loop

### Reasoning
LearningAgent transforms from write-only telemetry to the core of the online learning feedback loop.

### What to do
Upgrade LearningAgent to aggregate outcomes, synthesize patterns via LLM, and publish insights that other agents can consume.

### How
1. Subscribe to: `opportunity:detected`, `risk:approved`, execution outcomes, fills, incidents
2. Maintain rolling aggregates per market: edge achieved, slippage, timeout rate, win rate
3. Periodically (every N events or M seconds) call LLM to summarize patterns
4. Use prompt template for insight synthesis
5. Publish `learning:insight` events with structured insights
6. Cache insights in memory (Map by market_id) with TTL
7. Persist insights to `decisions` table for durability
8. Expose `getInsight(marketId)` method for other agents

### Prompt template
```json
{
  "task": "summarize_outcomes",
  "inputs": {
    "window_ms": 300000,
    "stats_by_market": {
      "market_123": {"trades": 10, "wins": 8, "avg_edge": 0.035, "avg_slippage": 0.002}
    }
  },
  "output": {
    "insights": [
      {"market_id": "market_123", "signal": "high_confidence", "value": 0.8, "ttl_ms": 60000, "confidence": 0.85}
    ]
  }
}
```

### Files impacted
- `src/agents/learning/LearningAgent.ts`
- `src/agents/learning/types.ts` (new file if needed)

### End goal
LearningAgent continuously learns from outcomes and publishes actionable insights.

### Acceptance criteria
- [ ] Aggregates update on relevant events
- [ ] LLM called periodically to synthesize insights
- [ ] Insights published via `learning:insight` events
- [ ] Insights cached with TTL
- [ ] Other agents can query insights via `getInsight()`
- [ ] Unit tests for aggregation and insight publishing
- [ ] `npm run test` passes

---

## Task 5 — ScannerAgent Priority Advisor (Shadow Mode)

### Reasoning
ScannerAgent can use learned insights to prioritize which markets to evaluate first, improving opportunity detection.

### What to do
Add LLM-based priority scoring to ScannerAgent in shadow mode (log only, don't affect behavior initially).

### How
1. Subscribe to `learning:insight` events
2. Maintain insight cache from LearningAgent
3. After detecting opportunities, call LLM for priority scoring
4. Use prompt template with market data and historical insights
5. Shadow mode: log LLM priority vs deterministic priority, don't reorder
6. Add config flag `LLM_SCANNER_MODE=shadow|advisory|disabled`
7. When advisory mode enabled, use LLM priority to reorder opportunity queue

### Prompt template
```json
{
  "task": "score_market",
  "inputs": {
    "market_id": "...",
    "current_edge": 0.035,
    "recent_outcomes": {"wins": 8, "losses": 2, "avg_slippage": 0.002},
    "book_quality": {"depth": 1000, "spread": 0.01}
  },
  "constraints": {
    "no_trade_decisions": true
  },
  "output": {
    "priority_score": 0.85,
    "rationale": "High recent win rate with low slippage",
    "confidence": 0.8
  }
}
```

### Files impacted
- `src/agents/scanner/ScannerAgent.ts`

### End goal
ScannerAgent uses learned insights to intelligently prioritize markets.

### Acceptance criteria
- [ ] Shadow mode logs LLM vs deterministic priority
- [ ] Advisory mode reorders opportunities by LLM score
- [ ] Deterministic gate evaluation unchanged
- [ ] LLM timeout/failure = use deterministic priority
- [ ] Unit tests for both modes
- [ ] `npm run test` passes

---

## Task 6 — RiskAgent Sizing Advisor

### Reasoning
RiskAgent can become more conservative (smaller size) in response to recent outcomes without ever increasing exposure beyond deterministic limits.

### What to do
Add an LLM sizing advisor that can only recommend a **conservative** size (≤ deterministic size). Start in shadow mode; only apply in advisory mode.

### How
1. Compute deterministic size using existing RiskAgent logic (this remains the baseline)
2. Call LLM with: deterministic size (= max allowed), min order size, binding constraint, and recent outcome aggregates
3. LLM returns a recommended size that must satisfy: `min_size ≤ recommended_size ≤ deterministic_size`
4. **CLAMP** LLM output to `[min_size, deterministic_size]` (never allow up-sizing)
5. Shadow mode: record recommendation + delta but do not apply
6. Advisory mode: apply clamped size; if LLM output invalid/late, use deterministic size
7. Add config flag `LLM_RISK_MODE=disabled|shadow|advisory`

### Prompt template
```json
{
  "task": "recommend_size",
  "inputs": {
    "min_size": 10,
    "deterministic_size": 50,
    "risk_constraints": {
      "max_per_trade_loss": 25,
      "current_exposure": 500,
      "max_exposure": 1000
    },
    "market_insights": {"confidence": 0.8, "recent_win_rate": 0.8}
  },
  "output": {
    "recommended_size": 40,
    "reason": "Recent delayed-ack rate elevated; be more conservative",
    "confidence": 0.85
  }
}
```

### Files impacted
- `src/agents/risk/RiskAgent.ts`

### End goal
RiskAgent uses LLM to optimize sizing while never violating deterministic bounds.

### Acceptance criteria
- [ ] LLM size always clamped to `[min_size, deterministic_size]` (no up-sizing)
- [ ] Invalid LLM output → deterministic size
- [ ] Timeout → deterministic size
- [ ] Decision logged with fallback reason if applicable
- [ ] Unit tests for clamp/fallback logic
- [ ] `npm run test` passes

---

## Task 7 — ExecutionAgent Advisory Hints

### Reasoning
ExecutionAgent is latency-sensitive (1557 lines, 17-state machine). LLM provides hints for future trades, not real-time decisions.

### What to do
Add advisory hint consumption to ExecutionAgent that applies learned hints to timeout/unwind strategies.

### How
1. **NO LLM calls on hot path** — state machine stays deterministic
2. Subscribe to `learning:insight` events
3. Maintain cached hints (schema-validated + bounded): timeout multipliers, unwind preferences
4. Shadow mode: record suggested hints but do not apply
5. Advisory mode: apply hints **only at trade setup** and only within configured bounds (hints cannot change state transitions or relax risk)
6. Log when hints are applied (and when they are ignored/clamped)
7. Add config flag `LLM_EXECUTION_MODE=disabled|shadow|advisory`

### Prompt template (used by LearningAgent for execution hints)
```json
{
  "task": "execution_hint",
  "inputs": {
    "market_id": "...",
    "recent_failures": [{"type": "timeout", "count": 3}],
    "avg_latency_ms": 150
  },
  "constraints": {
    "no_state_machine_changes": true,
    "conservative_only": true
  },
  "output": {
    "timeout_multiplier": 0.8,
    "unwind_hint": "aggressive",
    "confidence": 0.7
  }
}
```

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`

### End goal
ExecutionAgent uses pre-computed hints to optimize timeout/unwind without blocking on LLM calls.

### Acceptance criteria
- [ ] No LLM calls during active execution
- [ ] Hints applied at trade setup only
- [ ] State machine transitions unchanged
- [ ] Missing hints → default parameters
- [ ] Unit tests for hint application
- [ ] `npm run test` passes

---

## Task 8 — PortfolioAgent Anomaly Detection

### Reasoning
PortfolioAgent can use LLM to detect anomalies in fill reconciliation and position drift.

### What to do
Add LLM-based anomaly detection that raises alerts for unusual patterns.

### How
1. After reconciliation, call LLM with portfolio snapshot
2. LLM analyzes for anomalies: unexpected position sizes, drift, reconciliation failures
3. Anomaly detected → emit `ops:alert` event (not trading decision)
4. Add config flag `LLM_PORTFOLIO_MODE=advisory|disabled`

### Prompt template
```json
{
  "task": "detect_anomaly",
  "inputs": {
    "snapshot": {
      "positions": [...],
      "pending_trades": [...],
      "recent_fills": [...],
      "drift_from_expected": 0.05
    }
  },
  "output": {
    "anomaly": true,
    "severity": "medium",
    "reason": "Position drift exceeds 5% threshold",
    "confidence": 0.9
  }
}
```

### Files impacted
- `src/agents/portfolio/PortfolioAgent.ts`

### End goal
PortfolioAgent detects anomalies and raises alerts proactively.

### Acceptance criteria
- [ ] Anomalies emit `ops:alert` events
- [ ] No trading decisions made by LLM
- [ ] LLM failure → no alert (fail safe)
- [ ] Unit tests for anomaly detection
- [ ] `npm run test` passes

---

## Task 9 — MarketDataAgent Outlier Detection

### Reasoning
MarketDataAgent can detect outliers in price feeds that may indicate data quality issues.

### What to do
Add LLM-based outlier detection for orderbook data.

### How
1. On each market update, optionally check for outliers
2. LLM analyzes orderbook for: price gaps, unusual spreads, suspicious depth
3. Outlier detected → log warning, optionally emit event
4. Low priority — simple heuristics may suffice initially
5. Add config flag `LLM_MARKETDATA_MODE=advisory|disabled`

### Prompt template
```json
{
  "task": "detect_outlier",
  "inputs": {
    "orderbook": {
      "bids": [...],
      "asks": [...],
      "mid_price": 0.55,
      "spread": 0.02,
      "timestamp": "..."
    },
    "recent_history": {"avg_spread": 0.01, "avg_depth": 1000}
  },
  "output": {
    "outlier": false,
    "reason": null,
    "confidence": 0.95
  }
}
```

### Files impacted
- `src/agents/market-data/MarketDataAgent.ts`

### End goal
MarketDataAgent detects data quality issues proactively.

### Acceptance criteria
- [ ] Outliers logged with rationale
- [ ] No trading decisions affected
- [ ] LLM failure → normal operation
- [ ] Unit tests for outlier detection
- [ ] `npm run test` passes

---

## Task 10 — OpsAgent Health Summaries

### Reasoning
OpsAgent can provide predictive health alerts based on system metrics patterns.

### What to do
Add LLM-based health summary generation for proactive alerting.

### How
1. Periodically call LLM with system metrics
2. LLM analyzes for: degradation trends, capacity issues, anomalies
3. Generate health summary with risk level and actionable alerts
4. Emit `ops:health_summary` event
5. Add config flag `LLM_OPS_MODE=advisory|disabled`

### Prompt template
```json
{
  "task": "health_summary",
  "inputs": {
    "metrics": {
      "cpu_usage": 0.45,
      "memory_usage": 0.60,
      "latency_p95": 85,
      "error_rate": 0.001,
      "circuit_breaker_state": "closed"
    },
    "trends": {"latency_trend": "increasing", "error_trend": "stable"}
  },
  "output": {
    "risk_level": "low",
    "alerts": [],
    "summary": "System healthy, latency slightly elevated",
    "confidence": 0.9
  }
}
```

### Files impacted
- `src/agents/ops/OpsAgent.ts`

### End goal
OpsAgent provides predictive health insights.

### Acceptance criteria
- [ ] Health summaries generated periodically
- [ ] Alerts raised for elevated risk levels
- [ ] LLM failure → no summary (fail safe)
- [ ] Unit tests for health summary
- [ ] `npm run test` passes

---

## Task 11 — Mock LLM Client for Testing

### Reasoning
Need deterministic LLM responses for testing to maintain 95% coverage.

### What to do
Create a MockLLMClient with configurable responses and failure modes.

### How
1. Create `src/services/llm/MockLLMClient.ts`
2. Support: fixed responses, sequence responses, failure injection, latency simulation
3. Match real client interface exactly
4. Use in all unit and integration tests
5. Add test fixtures for each agent's prompts

### Files impacted
- `src/services/llm/MockLLMClient.ts` (new file)
- `tests/unit/*.test.ts` (updates)
- `tests/fixtures/llm/` (new directory)

### End goal
All LLM-related code is testable with deterministic mock responses.

### Acceptance criteria
- [ ] MockLLMClient implements same interface as LLMClient
- [ ] Supports success, timeout, error, invalid response scenarios
- [ ] Test fixtures for each agent type
- [ ] Coverage >= 95% maintained
- [ ] `npm run test:coverage` passes

---

## Task 12 — Integration Testing in Shadow Mode

### Reasoning
Need to validate LLM integration doesn't affect existing behavior before enabling advisory mode.

### What to do
Add integration tests that run LLM in shadow mode and verify deterministic behavior unchanged.

### How
1. Create `tests/integration/llm-shadow.test.ts`
2. Run full pipeline with LLM in shadow mode
3. Verify: same trades executed, same gates enforced, same outcomes
4. Compare LLM suggestions vs deterministic decisions (log discrepancies)
5. Add shadow mode metrics to telemetry

### Files impacted
- `tests/integration/llm-shadow.test.ts` (new file)
- `src/telemetry/` (shadow mode metrics)

### End goal
LLM integration validated in shadow mode before production rollout.

### Acceptance criteria
- [ ] Shadow mode logs all LLM suggestions
- [ ] Deterministic behavior unchanged in shadow mode
- [ ] Discrepancy metrics available
- [ ] Integration tests pass
- [ ] `npm run test` passes

---

## Environment Variables

Add to `.env.example`:

```bash
# Global kill switches (default off)
LLM_ENABLED=false
LLM_DATA_EXPORT_ENABLED=false

# LLM Provider Configuration
LLM_PRIMARY_PROVIDER=opencode-zen
LLM_FALLBACK_PROVIDER=openrouter
LLM_PRIMARY_BASE_URL=https://opencode.ai/zen/v1
LLM_FALLBACK_BASE_URL=https://openrouter.ai/api/v1
LLM_PRIMARY_API_KEY=
LLM_FALLBACK_API_KEY=

# LLM Routing (OpenRouter-specific)
LLM_OPENROUTER_SORT=latency
LLM_OPENROUTER_ALLOW_FALLBACKS=false
LLM_OPENROUTER_HTTP_REFERER=
LLM_OPENROUTER_X_TITLE=

# LLM Global Settings
LLM_TIMEOUT_MS=500
LLM_MAX_RETRIES=0

# LLM Circuit Breaker
LLM_CB_FAILURE_THRESHOLD=5
LLM_CB_COOLDOWN_MS=30000
LLM_CB_HALF_OPEN_SUCCESSES=2

# Per-Agent LLM Configuration
LLM_EXECUTION_PROVIDER=openrouter
LLM_EXECUTION_MODEL=google/gemini-3-flash-preview
LLM_EXECUTION_MODE=disabled
LLM_EXECUTION_TIMEOUT_MS=500

LLM_RISK_PROVIDER=opencode-zen
LLM_RISK_MODEL=glm-4.7-free
LLM_RISK_MODE=disabled
LLM_RISK_TIMEOUT_MS=300

LLM_SCANNER_PROVIDER=opencode-zen
LLM_SCANNER_MODEL=glm-4.7-free
LLM_SCANNER_MODE=disabled
LLM_SCANNER_TIMEOUT_MS=500

LLM_LEARNING_PROVIDER=openrouter
LLM_LEARNING_MODEL=minimax/minimax-m2.1
LLM_LEARNING_MODE=disabled
LLM_LEARNING_TIMEOUT_MS=2000

LLM_PORTFOLIO_PROVIDER=openrouter
LLM_PORTFOLIO_MODEL=moonshotai/kimi-k2
LLM_PORTFOLIO_MODE=disabled
LLM_PORTFOLIO_TIMEOUT_MS=1000

LLM_MARKETDATA_PROVIDER=opencode-zen
LLM_MARKETDATA_MODEL=gpt-5-nano
LLM_MARKETDATA_MODE=disabled
LLM_MARKETDATA_TIMEOUT_MS=500

LLM_OPS_PROVIDER=openrouter
LLM_OPS_MODEL=moonshotai/kimi-k2
LLM_OPS_MODE=disabled
LLM_OPS_TIMEOUT_MS=1000
```

---

## Phased Rollout

| Phase | Agent | Mode | Risk | Duration |
|-------|-------|------|------|----------|
| 1 | LearningAgent | active | Low — no trading impact | Week 1 |
| 2 | ScannerAgent | shadow | Low — log only | Week 1 |
| 3 | ScannerAgent | advisory | Low — priority only | Week 1 |
| 4 | RiskAgent | shadow | Low — log only | Week 2 |
| 5 | RiskAgent | advisory | Medium — size can only decrease | Week 2 |
| 6 | ExecutionAgent | shadow | Low — hints computed but not applied | Week 2 |
| 7 | ExecutionAgent | advisory | Low — cached hints only | Week 2 |
| 8 | Portfolio/MarketData/Ops | advisory | Low — alerts only | Week 2 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| LLM violates gates | All outputs clamped to deterministic bounds; gates always enforced post-LLM |
| LLM latency impacts trading | No LLM on hot path; cached hints only |
| LLM unavailable | Fail open to deterministic logic; circuit breaker prevents cascading |
| LLM output invalid | Strict Zod validation; invalid = fallback |
| LLM suggests higher risk | Conservative-only constraints (no up-sizing / no relaxed timeouts); clamp + ignore on low confidence |
| LLM randomness causes drift | Pin `temperature=0` for decision-affecting calls, keep outputs short/structured, and require validation + clamping |
| Prompt injection via external strings | Treat market text as tainted data; omit when possible, otherwise isolate/limit and never execute instructions from it |
| Data export / privacy | Use `LLM_DATA_EXPORT_ENABLED` to control inclusion of portfolio/orderbook/trade payloads (allowed); always redact secret keys and avoid logging secrets locally |
| Decision-store bloat | Default redacted storage (hashes + bounded outputs), size caps, and retention pruning |
| Cost overrun | Cheap/free models only; rate limiting per agent |
| Learning loop diverges | Insights are suggestions only; deterministic gates unchanged |

---

## File-by-File Implementation Sequence

1. `package.json` — Task 2 (add `openai`)
2. `src/config/llm.ts` — Task 1 (new file)
3. `.env.example` — Task 1
4. `src/services/llm/*.ts` — Task 2 (new files)
5. `src/domain/llm.ts` — Task 3 (new file)
6. `src/core/EventStore.ts` — Task 3
7. `src/agents/learning/LearningAgent.ts` — Task 4
8. `src/agents/scanner/ScannerAgent.ts` — Task 5
9. `src/agents/risk/RiskAgent.ts` — Task 6
10. `src/agents/execution/ExecutionAgent.ts` — Task 7
11. `src/agents/portfolio/PortfolioAgent.ts` — Task 8
12. `src/agents/market-data/MarketDataAgent.ts` — Task 9
13. `src/agents/ops/OpsAgent.ts` — Task 10
14. `src/services/llm/MockLLMClient.ts` — Task 11 (new file)
15. `tests/integration/llm-shadow.test.ts` — Task 12 (new file)

---

## Dependencies to Add

| Package | Version | Purpose |
|---------|---------|---------|
| `openai` | `^4.x` | Official OpenAI Node SDK (supports `baseURL`, `defaultHeaders`, `timeout`, `maxRetries`, `_request_id`) |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-05 | Initial plan from Oracle synthesis |
