# Config + UI Knob Inventory

This document is the final inventory of configurable knobs and where they live.

## Principles

- **Infra knobs are env-only** to avoid runtime/UI drift.
- **Trade-critical knobs** are configured at runtime via the Ops API and can be edited from the dashboard.
- Source of truth:
  - Runtime env keys: `.env.example` + `src/config/env.ts`
  - Dashboard env keys: `dashboard/.env.example` + `dashboard/src/lib/dashboardConfig.ts`
  - Runtime UI schema (policy/risk): `src/config/schema.ts`

## Dashboard UI (runtime-editable, trade-critical)

These are edited via `PATCH /config/policy` and `PATCH /config/risk` and rendered schema-driven from `src/config/schema.ts`.

### `policy` (TradePolicy)

- Edge + spread + book quality: `edgeRequired`, `maxEdge`, `maxSpread`, `requireFreshBook`, `orderbookFreshnessMs`, `maxBookStalenessMs`, `topOfBookStabilityMs`, `maxLegSkewMs`
  - `orderbookFreshnessMs` is a legacy alias; it must match `maxBookStalenessMs` to avoid silent overrides.
- Inventory + strategy: `strategyMode`, `maxOpenInventorySeconds`
- Signals + EV: `signalMode`, `evEdgeRequired`, `evConfidenceMin`, `evMaxPerMarketNotional`, `evMaxPortfolioNotional`, `evCooldownSeconds`, `evModelMode`, `evModelRefreshMinutes`, `evCalibrationMethod`, `evModelConfidenceFloor`, `evWebSearchExaEnabled`, `evWebSearchFirecrawlEnabled`, `evWebSearchPrimary`, `evWebSearchLookbackDays`, `evWebSearchMaxResults`, `evWebSearchCacheTtlSeconds`
  - `signalMode=near_zero` disables EV signals; `signalMode=ev` disables near-zero arbitrage.
- Execution safety gates: `rejectDelayed`, `maxDecisionLatencyMs`, `maxDelayedAckRate`, `minPairedFillRate`, `minEdgeTicks`
- Depth/slippage gates: `depthHeadroomFraction`, `depthBufferMultiplier`, `minDepthLevels`, `entrySlippageToleranceBps`, `priceBandBps`
  - `depthBufferMultiplier=0` disables the extra depth buffer requirement.
- Velocity/OTR throttles: `maxOrdersPerMinute`, `orderVelocityWindowMs`, `maxOrderToTradeRatio`, `orderToTradeWindowMs`
- Execution timeouts: `submitTimeoutMs`, `ackTimeoutMs`, `fillTimeoutMs`, `cancelTimeoutMs`
  - `fillTimeoutMs` must be > 0 in `near_zero_risk` mode; `0` skips waiting for user fills (optimistic completion).
- Fallback market metadata (used only when venue data missing): `fallbackTickSize`, `fallbackMinOrderSize`

### `risk` (RiskConfig)

- Sizing + exposure: `targetTradeFraction`, `maxTradeFraction`, `maxMarketExposureFraction`
- Loss bounds: `maxAttemptLossFraction`, `maxDailyDrawdownFraction`, `dailyLossLimitFraction`
  - `maxDailyDrawdownFraction=0` disables the drawdown check (daily loss limit still applies if set).
- Circuit breaker behavior: `marketCooldownSeconds`, `marketCircuitFailureThreshold`, `marketCircuitHalfOpenSuccesses`
- Unwind constraints: `maxUnwindLossFraction`, `maxUnwindLossTicks`, `unwindSlippageToleranceBps`, `maxPerTradeLossDollars`

## Dashboard UI (env-only, build-time)

These are set via `dashboard/.env.example` and are not editable at runtime:

- Ops connectivity/auth: `VITE_OPS_BASE_URL`, `VITE_OPS_API_TOKEN`
- Polling: `VITE_PORTFOLIO_REFRESH_MS`, `VITE_SLO_REFRESH_MS`
- Incidents UI: `VITE_INCIDENTS_LIMIT`, `VITE_INCIDENTS_PREVIEW_LIMIT`

## Runtime (env-only, infra/ops/connectivity)

All infra knobs are env-only; the dashboard shows a read-only snapshot via `GET /config/infra`.

Use `.env.example` for the full list; the most operationally relevant groups are:

- Runtime/ops API: `PORT`, `OPS_API_ENABLED`, `OPS_API_HOST`, `OPS_API_TOKEN`
- Ops behavior: `OPS_HEALTH_INTERVAL_MS`, `OPS_STREAM_HEARTBEAT_MS`, `OPS_INCIDENTS_LIMIT`, `OPS_SHUTDOWN_TIMEOUT_MS`
- Book refresh + stale quarantine: `OPS_BOOK_REFRESH_INTERVAL_MS`, `OPS_BOOK_REFRESH_STALE_MS`, `OPS_BOOK_STALE_QUARANTINE_THRESHOLD`, `OPS_BOOK_STALE_QUARANTINE_WINDOW_MS`, `OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS` (0 = use risk cooldown)
- Reconciliation: `OPS_RECONCILIATION_INTERVAL_MS`, `OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS`, `OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE`
- Telemetry persistence: `EVENT_STORE_PATH`, `EVENT_STORE_METRICS_RETENTION_DAYS`, `EVENT_STORE_METRICS_PRUNE_INTERVAL_MS`
- Polymarket endpoints + rate limiting: `POLYMARKET_CLOB_*`, `POLYMARKET_WS_*`, `POLYMARKET_USER_WS_URL`
- Polymarket auth derivation: `POLYMARKET_L1_PRIVATE_KEY`, `POLYMARKET_L1_NONCE` (optional; derive API creds at boot)
- Market catalog filters: `MARKET_CATALOG_PATH`, `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS`, `MARKET_CATALOG_MIN_VOLUME_24H`, `MARKET_CATALOG_PAGE_SIZE`, `MARKET_CATALOG_MAX_PAGES`, `MARKET_CATALOG_ORDER`
- EV web search (direct API): `EXA_*`, `FIRECRAWL_*`, `EV_WEBSEARCH_*`
- RPC providers + wait defaults: `*_RPC_URL`, `*_WS_URL`, `*_RPC_RPS`, `RPC_RATE_LIMIT_WINDOW_MS`, `RPC_WAIT_CONFIRMATIONS`, `RPC_WAIT_TIMEOUT_MS`, `RPC_CIRCUIT_*`
- Live trading credentials: `ALCHEMY_API_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_POSITIONS_USER`

## Health endpoints

- Liveness: `GET /health/live` (used by Docker healthcheck)
- Readiness: `GET /health/ready` (for orchestrators; returns `503` when degraded)
