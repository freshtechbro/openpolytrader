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
- Inventory + strategy: `strategyMode`, `maxOpenInventorySeconds`
- Execution safety gates: `rejectDelayed`, `maxDecisionLatencyMs`, `maxDelayedAckRate`, `minPairedFillRate`, `minEdgeTicks`
- Depth/slippage gates: `depthHeadroomFraction`, `depthBufferMultiplier`, `minDepthLevels`, `entrySlippageToleranceBps`, `priceBandBps`
- Velocity/OTR throttles: `maxOrdersPerMinute`, `orderVelocityWindowMs`, `maxOrderToTradeRatio`, `orderToTradeWindowMs`
- Execution timeouts: `submitTimeoutMs`, `ackTimeoutMs`, `fillTimeoutMs`, `cancelTimeoutMs`
- Fallback market metadata (used only when venue data missing): `fallbackTickSize`, `fallbackMinOrderSize`

### `risk` (RiskConfig)

- Sizing + exposure: `targetTradeFraction`, `maxTradeFraction`, `maxMarketExposureFraction`
- Loss bounds: `maxAttemptLossFraction`, `maxDailyDrawdownFraction`, `dailyLossLimitFraction`
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
- Reconciliation: `OPS_RECONCILIATION_INTERVAL_MS`, `OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS`, `OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE`
- Telemetry persistence: `EVENT_STORE_PATH`, `EVENT_STORE_METRICS_RETENTION_DAYS`, `EVENT_STORE_METRICS_PRUNE_INTERVAL_MS`
- Polymarket endpoints + rate limiting: `POLYMARKET_CLOB_*`, `POLYMARKET_WS_*`, `POLYMARKET_USER_WS_URL`
- RPC providers + wait defaults: `*_RPC_URL`, `*_WS_URL`, `*_RPC_RPS`, `RPC_RATE_LIMIT_WINDOW_MS`, `RPC_WAIT_CONFIRMATIONS`, `RPC_WAIT_TIMEOUT_MS`, `RPC_CIRCUIT_*`
- Live trading credentials: `ALCHEMY_API_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_POSITIONS_USER`

## Health endpoints

- Liveness: `GET /health/live` (used by Docker healthcheck)
- Readiness: `GET /health/ready` (for orchestrators; returns `503` when degraded)

