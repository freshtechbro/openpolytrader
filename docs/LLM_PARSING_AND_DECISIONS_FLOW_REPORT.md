# LLM Parsing + Decisions Flow Report

Date: 2026-01-17

## Summary

- Fixed risk-profile directory overrides by normalizing directory paths to `${profile}.json` and blocking directory reads with a clear error.
- Hardened OpenAI-compatible output parsing to handle content arrays and nested outputs, reducing false `missing_output_text` failures.
- Verified decision flow through debug endpoints, persisted decisions, and Decisions UI filtering for Learning/Risk/Scanner.

## Changes Applied

### Parsing fixes

1. **OpenAI-compatible parsing** (`src/services/llm/OpenAISdkClient.ts`)
   - Added robust extraction for content arrays and nested output text.
   - Handles structured payloads without returning `null` when text is present.

2. **Risk profile override directory support** (`src/config/riskProfile.ts`)
   - If `path` is a directory, resolves `${path}/${profile}.json`.
   - Guarded against reading directories and returns explicit error.

### Tests added

- `tests/unit/openai-sdk-client-extract.test.ts` (new parsing cases)
- `tests/unit/risk-profile-override-dir.test.ts` (directory overrides)

## Verification Results

### API validation

- `POST /config/risk-profile` with `path=/app/settings/risk-gates` now succeeds:
  - Example: `{ "profile": "extra_high", "path": "/app/settings/risk-gates" }` -> `ok: true` and `persisted: true`

### Debug endpoints executed

- `POST /debug/learning/synthesize`
- `POST /debug/portfolio/analyze`
- `POST /debug/marketdata/outlier`
- `POST /debug/synthetic-opportunity`

### Decisions flow observed

- `/decisions` shows recent entries for:
  - `LearningAgent`, `MarketDataAgent`, `PortfolioAgent`, `RiskAgent`, `ScannerAgent`, `OpsAgent`
- Decisions UI filter check:
  - Learning/Risk/Scanner rows verified using live dashboard (script + screenshot).
  - Screenshot: `/tmp/decisions-filter-check.png`

### Tests + coverage

- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm run build` ✅
- `npm run test` ✅ (718 tests)
- `npm run test:coverage` ✅
  - Stmts: 97.41%, Branch: 94.03%, Funcs: 96.68%, Lines: 98.47%
- `npm --prefix dashboard run test:e2e` ✅

## Per‑Agent Decision + Wiring Report

### ExecutionAgent
- **LLM usage:** No direct LLM call.
- **Input sources:** Execution pipeline + optional `ExecutionAdvisor` hints.
- **Learning integration:** `ExecutionAdvisor` listens to `learning:insight` and stores per‑market hints (timeout multipliers + unwind hint). ExecutionAgent consumes these hints when configured.
- **Decision persistence:** No direct `logLLMDecision` call (execution decisions are deterministic state machine outputs).

### RiskAgent (RiskAdvisor)
- **LLM endpoint:** `chat.completions`
- **Prompt shape:** `{ recommended_size, reason, confidence }`
- **Decision flow:** Parses LLM output → clamps size → logs decision via `logLLMDecision`.
- **Downstream:** RiskAgent decisions feed Execution sizing.

### ScannerAgent
- **LLM endpoint:** `chat.completions`
- **Prompt shape:** `{ priority_score, rationale, confidence }`
- **Decision flow:** Uses LLM score for ranking opportunities, logs decision.
- **Downstream:** Score informs opportunity prioritization.

### LearningAgent
- **LLM endpoint:** `messages` for minimax/claude models; otherwise `chat.completions`.
- **Prompt shape:** `{ insights: [{ market_id, signal, value, ttl_ms, confidence }] }`
- **Decision flow:** Parses insights → updates cache + emits `learning:insight` → logs decision (even on failure).
- **Downstream:** Insights used by ScannerAgent and ExecutionAdvisor.

### PortfolioAgent
- **LLM endpoint:** `chat.completions`
- **Prompt shape:** `{ anomaly, severity, reason, confidence }`
- **Decision flow:** Parses anomalies → emits ops alerts if needed → logs decision.
- **Downstream:** Ops alerting and audit trail.

### MarketDataAgent
- **LLM endpoint:** `chat.completions`
- **Prompt shape:** `{ outlier, reason, confidence }`
- **Decision flow:** Parses outliers → emits `marketdata:outlier` when flagged → logs decision.
- **Downstream:** Market quality signals for scanner/risk.

### OpsAgent
- **LLM endpoint:** `chat.completions`
- **Prompt shape:** `{ risk_level, alerts, summary, confidence }`
- **Decision flow:** Parses system health summary → emits ops health summary → logs decision.
- **Downstream:** Ops dashboard + incident routing.

## ASC Flow Diagram

```
Operator / Debug Endpoint
  |
  | POST /debug/learning/synthesize
  v
Ops API (Fastify)
  |
  | -> LearningAgent.synthesizeInsights()
  |      - Build prompt envelope
  |      - LLMClient.call(...)
  |      - safeParseJSON + Zod validation
  |      - emit learning:insight (if valid)
  |      - logLLMDecision(...)
  v
EventStore.persistDecision()
  |
  +--> GET /decisions (persisted)
  |
  +--> messageBus.emit('llm:decision')
        -> metrics: llm_decision
        -> SSE /stream
        -> dashboard useEventStream
        -> Decisions table (live rows)
```

## Current Observations / Known Environment Issues

- Some Learning/MarketData decisions show `missing_output_text` when the fallback provider is used.
  - Root cause observed in runtime: `openrouter` circuit breaker or insufficient credits (HTTP 402 in prior logs).
  - Fix: add OpenRouter credits, or disable fallback in `.env` when not available.
- Primary provider (OpenCode Zen) is responding for OpsAgent; the parsing fix prevents false empty-output errors.

## Recommended Next Checks

1. Keep `LLM_PRIMARY_PROVIDER=opencode-zen` and verify the model list supported by OpenCode Zen.
2. Top up OpenRouter credits or disable fallback to avoid circuit-open errors on fallback calls.
3. Re-run `/debug/learning/synthesize` and confirm decision output contains parsed insights (no `missing_output_text`).
