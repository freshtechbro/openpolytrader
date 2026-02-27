# OpenPolyTrader

[![CI](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml/badge.svg)](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Coverage](https://img.shields.io/badge/coverage-97%25-brightgreen.svg)](docs/Testing/strategy.md)

> Near-zero-risk Polymarket CLOB arbitrage automation with event-sourced state, agent orchestration, and an ops dashboard.

<p align="center">
  <img src="docs/assets/readme/v2/readme-hero-v2-05.jpg" alt="OpenPolyTrader Polymarket trading dashboard hero" width="960" />
  <br />
  <sub>Polymarket operations view: order books, scanner/risk/execution flow, and portfolio exposure.</sub>
</p>

## Disclaimer

This project is an **experimental, research-focused trading tool**.

- It is for engineering research and operational experimentation.
- It is **not financial advice**, investment advice, or a solicitation to trade.
- Trading live markets can lead to losses, including total loss of capital.
- You are solely responsible for configuration, risk limits, and trading decisions.

## Table of Contents

- [Minimum Requirements](#minimum-requirements)
- [Priority Keys (Live Trading)](#priority-keys-live-trading)
- [Quickstart](#quickstart)
- [FW Strategy Summary](#fw-strategy-summary)
- [Environment Variables (Complete Index)](#environment-variables-complete-index)
- [AI Agent Setup Prompt](#ai-agent-setup-prompt)
- [Ops API](#ops-api)
- [Documentation Map](#documentation-map)

## Minimum Requirements

### Local Monitoring Only (No Live Trading)

- Node.js 20+
- npm
- `git`
- Backend + dashboard dependencies installed
- Optional but recommended: Docker (for `dev:live` workflow)

Minimum runtime settings for safe local usage:

- `TRADING_MODE=paper` or `TRADING_ENABLED=false`
- `OPS_API_TOKEN` (required by `npm run dev:ops` and `/ops/*` auth)
- Runtime ops session login at `/ops/*` using the backend token (no build-time dashboard token)

### Live Trading (Strict Minimum)

When `TRADING_ENABLED=true` and `TRADING_MODE=live`, the runtime enforces these keys in `src/config/env.ts`:

- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER`

Also required operationally for near-zero live mode:

- `POLYMARKET_USER_WS_URL` reachable for user channel updates
- `POLYMARKET_WS_URL` reachable for market data
- `POLYMARKET_CLOB_BASE_URL` and `POLYMARKET_DATA_API_BASE_URL` reachable

## Priority Keys (Live Trading)

### Priority 1: Required Keys

| Key | Why it is required |
| --- | --- |
| `ALCHEMY_API_KEY` | Required RPC authentication for Polygon connectivity in live mode |
| `POLYMARKET_API_KEY` | Required for private CLOB trading requests |
| `POLYMARKET_API_SECRET` | Required for private CLOB request signing/auth |
| `POLYMARKET_PASSPHRASE` | Required CLOB credential component |
| `POLYMARKET_POSITIONS_USER` | Required for portfolio reconciliation against Polymarket Data API |

### Priority 2: Strongly Recommended

| Key | Why it matters |
| --- | --- |
| `OPS_API_TOKEN` | Protects ops endpoints (`/config/*`, `/stream`, etc.) |
| `TRADING_MODE` | Explicitly controls execution mode (`off`, `shadow`, `paper`, `live`) |
| `RISK_PROFILE` | Ensures expected risk gate set at boot |

### Other Market Integrations

- **Active venue now:** Polymarket
- **Scaffolded, not active by default:** Kalshi (`PHASE2_CROSS_VENUE_ENABLED=false`)
- If cross-venue is enabled later, configure:
  - `KALSHI_API_KEY_ID`
  - `KALSHI_PRIVATE_KEY_PEM` or `KALSHI_PRIVATE_KEY_PATH`

## Quickstart

### 1. Install

```bash
npm install
npm --prefix dashboard install
cp .env.example .env
cp dashboard/.env.example dashboard/.env
```

Quick command/tool/flag index:

```bash
npm run help
```

### 2. Set Safe Defaults for Local Work

In `.env`:

```bash
TRADING_MODE=paper
TRADING_ENABLED=true
OPS_API_TOKEN=replace-with-secure-token
# Optional dev-only localhost token prefill for /ops/* login
OPS_DEV_SESSION_PREFILL_ENABLED=false
```

`npm run dev:ops` sets `OPS_DEV_SESSION_PREFILL_ENABLED=true` by default unless you override inline.

In `dashboard/.env`:

```bash
VITE_OPS_BASE_URL=http://localhost:3000
```

### 3. Start Full FW Dev Stack

```bash
npm run dev:ops
```

Access:

- Backend: `http://localhost:3000`
- Dashboard: `http://localhost:5174`
- Oracle sidecar: `http://127.0.0.1:7071`
- `dev:ops` enables localhost token prefill by default (`OPS_DEV_SESSION_PREFILL_ENABLED=true`)
- `dev:ops` runs startup health checks for oracle, backend, and dashboard.

Verify component status at any time:

```bash
npm run dev:ops:status
```

Disable prefill for a run:

```bash
OPS_DEV_SESSION_PREFILL_ENABLED=false npm run dev:ops
```

Stop:

```bash
npm run dev:ops:down
```

### 4. Validate

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run test:coverage
npm --prefix dashboard run build
```

## FW Strategy Summary

FWMM path is always active in runtime:

- Fully-corrective loop behavior is controlled by FW loop/gap/contraction policy knobs.
- FW baskets are Phase 1 pair-buy only (YES+NO buy per selected market).
- Non-converged FW loop outputs are rejected from execution, including paper mode.
- Basket execution supports `sequential_failfast` (default) and `batch_best_effort`.

Operational visibility:

- `/metrics` and `/stream` expose `fw_iteration`, `fw_gap`, `fw_active_set`, `fw_contraction`, and `fw_basket`.
- Dashboard Overview surfaces FW convergence and basket counters.

## Environment Variables (Complete Index)

Source of truth files:

- Backend/runtime: `.env.example`
- Dashboard: `dashboard/.env.example`
- Validation and defaults: `src/config/env.ts`
- Detailed descriptions: `docs/Operations/environment-reference.md`

<details>
<summary>Core runtime</summary>

`NODE_ENV`, `LOG_LEVEL`, `PORT`

</details>

<details>
<summary>Ops API + scheduling</summary>

`OPS_API_ENABLED`, `OPS_API_HOST`, `OPS_API_TOKEN`, `OPS_ALERT_WEBHOOK_URL`, `OPS_HEALTH_INTERVAL_MS`, `OPS_SHUTDOWN_TIMEOUT_MS`, `OPS_STREAM_HEARTBEAT_MS`, `OPS_INCIDENTS_LIMIT`, `OPS_RECONCILIATION_INTERVAL_MS`, `OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS`, `OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE`, `OPS_BOOK_REFRESH_INTERVAL_MS`, `OPS_BOOK_REFRESH_STALE_MS`, `OPS_BOOK_STALE_QUARANTINE_THRESHOLD`, `OPS_BOOK_STALE_QUARANTINE_WINDOW_MS`, `OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS`

</details>

<details>
<summary>Metrics + EventStore</summary>

`METRICS_MAX_EVENTS`, `INCIDENTS_MAX_EVENTS`, `ALLOWLIST_AUTO_RESUME`, `EVENT_STORE_PATH`, `EVENT_STORE_METRICS_RETENTION_DAYS`, `EVENT_STORE_METRICS_PRUNE_INTERVAL_MS`

</details>

<details>
<summary>Market catalog + trading modes</summary>

`TOTAL_CAPITAL`, `MARKET_CATALOG_PATH`, `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS`, `MARKET_CATALOG_MIN_VOLUME_24H`, `MARKET_CATALOG_MAX_SPREAD`, `MARKET_CATALOG_PAGE_SIZE`, `MARKET_CATALOG_MAX_PAGES`, `MARKET_CATALOG_ORDER`, `MARKET_CATALOG_EXCLUDE_ENDED_MARKETS`, `MARKET_CATALOG_EXPLORATION_ENABLED`, `MARKET_CATALOG_EXPLORATION_MAX_PAIRS`, `MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H`, `MARKET_CATALOG_EXPLORATION_MAX_PAGES`, `MARKET_CATALOG_PRESTART_MAX_AGE_MS`, `GAMMA_API_BASE_URL`, `TRADING_ENABLED`, `TRADING_MODE`, `RISK_PROFILE`, `RISK_PROFILE_PATH`, `RISK_PROFILE_ACTIVE_PATH`, `MAX_CONCURRENT_MARKETS`, `MAX_CAPITAL_IN_FLIGHT`, `PHASE2_CROSS_VENUE_ENABLED`

</details>

<details>
<summary>EV web search + FW oracle</summary>

`EXA_API_KEY`, `EXA_BASE_URL`, `EXA_SEARCH_PATH`, `EXA_CONTENTS_PATH`, `EXA_COOLDOWN_MS`, `EXA_COOLDOWN_FAILURE_THRESHOLD`, `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL`, `FIRECRAWL_SEARCH_PATH`, `FIRECRAWL_SCRAPE_PATH`, `FIRECRAWL_CRAWL_PATH`, `FIRECRAWL_CRAWL_ENABLED`, `EV_WEBSEARCH_TIMEOUT_MS`, `EV_WEBSEARCH_REQUESTS_PER_MINUTE`, `EV_WEBSEARCH_RATE_LIMIT_WINDOW_MS`, `EV_WEBSEARCH_MAX_CONTENT_BYTES`, `EV_WEBSEARCH_DOMAIN_ALLOWLIST`, `EV_WEBSEARCH_DOMAIN_DENYLIST`, `FW_ORACLE_BASE_URL`, `FW_ORACLE_TIMEOUT_MS`, `FW_ORACLE_API_KEY`, `FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD`, `FW_ORACLE_CIRCUIT_COOLDOWN_MS`

</details>

<details>
<summary>LLM advisory configuration</summary>

`LLM_ENABLED`, `LLM_DATA_EXPORT_ENABLED`, `LLM_PRIMARY_PROVIDER`, `LLM_FALLBACK_PROVIDER`, `LLM_PRIMARY_BASE_URL`, `LLM_FALLBACK_BASE_URL`, `LLM_PRIMARY_API_KEY`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_ENABLED`, `LLM_PRIMARY_RETRY_COUNT`, `LLM_OPENROUTER_SORT`, `LLM_OPENROUTER_ALLOW_FALLBACKS`, `LLM_OPENROUTER_HTTP_REFERER`, `LLM_OPENROUTER_X_TITLE`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_CB_FAILURE_THRESHOLD`, `LLM_CB_COOLDOWN_MS`, `LLM_CB_HALF_OPEN_SUCCESSES`, `LLM_EXECUTION_PROVIDER`, `LLM_EXECUTION_MODEL`, `LLM_EXECUTION_MODE`, `LLM_EXECUTION_TIMEOUT_MS`, `LLM_EXECUTION_MODEL_BACKUP`, `LLM_EXECUTION_ENDPOINT_BACKUP`, `LLM_EXECUTION_FALLBACK_PROVIDER_MODEL`, `LLM_RISK_PROVIDER`, `LLM_RISK_MODEL`, `LLM_RISK_MODE`, `LLM_RISK_TIMEOUT_MS`, `LLM_RISK_MODEL_BACKUP`, `LLM_RISK_ENDPOINT_BACKUP`, `LLM_RISK_FALLBACK_PROVIDER_MODEL`, `LLM_SCANNER_PROVIDER`, `LLM_SCANNER_MODEL`, `LLM_SCANNER_MODE`, `LLM_SCANNER_TIMEOUT_MS`, `LLM_SCANNER_SCORE_TOP_N`, `LLM_SCANNER_SCORE_CONCURRENCY`, `LLM_SCANNER_SHADOW_MIN_INTERVAL_MS`, `LLM_SCANNER_MODEL_BACKUP`, `LLM_SCANNER_ENDPOINT_BACKUP`, `LLM_SCANNER_FALLBACK_PROVIDER_MODEL`, `LLM_LEARNING_PROVIDER`, `LLM_LEARNING_MODEL`, `LLM_LEARNING_MODE`, `LLM_LEARNING_TIMEOUT_MS`, `LLM_LEARNING_MODEL_BACKUP`, `LLM_LEARNING_ENDPOINT_BACKUP`, `LLM_LEARNING_FALLBACK_PROVIDER_MODEL`, `LLM_PORTFOLIO_PROVIDER`, `LLM_PORTFOLIO_MODEL`, `LLM_PORTFOLIO_MODE`, `LLM_PORTFOLIO_TIMEOUT_MS`, `LLM_PORTFOLIO_MODEL_BACKUP`, `LLM_PORTFOLIO_ENDPOINT_BACKUP`, `LLM_PORTFOLIO_FALLBACK_PROVIDER_MODEL`, `LLM_MARKETDATA_PROVIDER`, `LLM_MARKETDATA_MODEL`, `LLM_MARKETDATA_MODE`, `LLM_MARKETDATA_TIMEOUT_MS`, `LLM_MARKETDATA_MODEL_BACKUP`, `LLM_MARKETDATA_ENDPOINT_BACKUP`, `LLM_MARKETDATA_FALLBACK_PROVIDER_MODEL`, `LLM_OPS_PROVIDER`, `LLM_OPS_MODEL`, `LLM_OPS_MODE`, `LLM_OPS_TIMEOUT_MS`, `LLM_OPS_MODEL_BACKUP`, `LLM_OPS_ENDPOINT_BACKUP`, `LLM_OPS_FALLBACK_PROVIDER_MODEL`

</details>

<details>
<summary>Polymarket REST + WebSocket + Data API</summary>

`POLYMARKET_CLOB_BASE_URL`, `POLYMARKET_CLOB_TIMEOUT_MS`, `POLYMARKET_CLOB_RATE_LIMIT_PER_SEC`, `POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS`, `POLYMARKET_CLOB_ORDER_PATH`, `POLYMARKET_CLOB_BATCH_ORDER_PATH`, `POLYMARKET_CLOB_CANCEL_ORDER_PATH`, `POLYMARKET_CLOB_CANCEL_ORDERS_PATH`, `POLYMARKET_CLOB_CANCEL_ALL_PATH`, `POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH`, `POLYMARKET_CLOB_ACTIVE_ORDERS_PATH`, `POLYMARKET_CLOB_RETRY_MAX_RETRIES`, `POLYMARKET_CLOB_RETRY_BASE_DELAY_MS`, `POLYMARKET_CLOB_RETRY_MAX_DELAY_MS`, `POLYMARKET_WS_URL`, `POLYMARKET_USER_WS_URL`, `POLYMARKET_WS_HEARTBEAT_MS`, `POLYMARKET_WS_RECONNECT_BASE_MS`, `POLYMARKET_WS_RECONNECT_MAX_MS`, `POLYMARKET_WS_RECONNECT_JITTER_PCT`, `POLYMARKET_DATA_API_BASE_URL`, `POLYMARKET_DATA_API_POSITIONS_PATH`, `POLYMARKET_DATA_API_TIMEOUT_MS`, `POLYMARKET_DATA_API_RATE_LIMIT_PER_SEC`, `POLYMARKET_DATA_API_RATE_LIMIT_WINDOW_MS`, `POLYMARKET_DATA_API_RETRY_MAX_RETRIES`, `POLYMARKET_DATA_API_RETRY_BASE_DELAY_MS`, `POLYMARKET_DATA_API_RETRY_MAX_DELAY_MS`, `POLYMARKET_POSITIONS_USER`, `POLYMARKET_POSITIONS_SIZE_THRESHOLD`, `POLYMARKET_POSITIONS_LIMIT`, `POLYMARKET_POSITIONS_OFFSET`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_L1_PRIVATE_KEY`, `POLYMARKET_L1_NONCE`

</details>

<details>
<summary>RPC infrastructure + Phase 2 (Kalshi)</summary>

`ALCHEMY_RPC_URL`, `ALCHEMY_WS_URL`, `ALCHEMY_RPC_RPS`, `QUICKNODE_RPC_URL`, `QUICKNODE_RPC_RPS`, `CHAINSTACK_RPC_URL`, `CHAINSTACK_WS_URL`, `CHAINSTACK_RPC_RPS`, `ANKR_RPC_URL`, `ANKR_RPC_RPS_PHASE1`, `ANKR_RPC_RPS_PHASE2`, `PRIVATE_RPC_URL`, `PRIVATE_WS_URL`, `PRIVATE_RPC_RPS`, `RPC_RATE_LIMIT_WINDOW_MS`, `RPC_WAIT_CONFIRMATIONS`, `RPC_WAIT_TIMEOUT_MS`, `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE1`, `RPC_CIRCUIT_TIMEOUT_MS_PHASE1`, `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE1`, `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE2`, `RPC_CIRCUIT_TIMEOUT_MS_PHASE2`, `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE2`, `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3`, `RPC_CIRCUIT_TIMEOUT_MS_PHASE3`, `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE3`, `ALCHEMY_API_KEY`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM`, `KALSHI_PRIVATE_KEY_PATH`

</details>

<details>
<summary>Dashboard environment variables</summary>

`VITE_OPS_BASE_URL`, `VITE_PORTFOLIO_REFRESH_MS`, `VITE_SLO_REFRESH_MS`, `VITE_INCIDENTS_LIMIT`, `VITE_INCIDENTS_PREVIEW_LIMIT`, `VITE_PUBLIC_REPO_URL`

</details>

## AI Agent Setup Prompt

Use this prompt with your coding agent:

```text
Set up OpenPolyTrader locally in safe paper mode.

Requirements:
1) Install backend and dashboard dependencies.
2) Create .env and dashboard/.env from examples.
3) Set TRADING_MODE=paper, TRADING_ENABLED=true.
4) Set OPS_API_TOKEN and use runtime ops session login on /ops/*.
5) Start with npm run dev:ops.
6) Verify:
   - GET /health returns healthy
   - dashboard loads on :5174
   - /ops/overview prompts for token and loads after sign-in
   - authenticated /config works with Authorization: Bearer $OPS_API_TOKEN
7) Run quality checks: npm run lint, npm run typecheck, npm run build, npm run test, npm run test:coverage.
8) Do not switch to live mode unless ALCHEMY_API_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE, and POLYMARKET_POSITIONS_USER are configured.

Return a short report with commands run, files changed, and verification results.
```

## Ops API

Base URL: `http://localhost:3000`

See full endpoint docs in `docs/API.md`.

Common endpoints:

- `GET /health`, `GET /health/live`, `GET /health/ready`
- `GET /metrics`, `GET /slo`, `GET /stream`
- `GET /allowlist`, `GET /markets`, `GET /incidents`, `GET /portfolio`, `GET /decisions`
- `GET /config`, `GET /config/schema`, `GET /config/infra`, `GET /config/risk-profiles`
- `PATCH /config/policy`, `PATCH /config/risk`
- `POST /config/risk-profile`, `POST /config/trading-mode`, `POST /allowlist/:marketId/resume`

Auth (when `OPS_API_TOKEN` is set):

```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

## Documentation Map

- API reference: `docs/API.md`
- Architecture (with end-to-end event flow diagrams): `docs/ARCHITECTURE.md`
- Local setup spec and quickstart details: `docs/Development/setup.md`
- Environment variable descriptions and defaults: `docs/Operations/environment-reference.md`
- Runtime/ops procedures: `docs/Operations/runbook.md`
- Config knobs: `docs/Operations/config-knobs.md`
- Security: `docs/Operations/security.md`
- Testing strategy: `docs/Testing/strategy.md`

## License

MIT License. See `LICENSE`.
