# Config + UI Knob Inventory

This document is the final inventory of configurable knobs and where they live.

For minimum required keys and the complete environment variable index, see `docs/Operations/environment-reference.md`.

Command references:
- Full CLI matrix: `docs/Development/commands.md`
- Ops procedures: `docs/Operations/runbook.md`

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
  - `orderbookFreshnessMs` is a legacy alias; it must match `maxBookStalenessMs` and validation fails if they differ.
- Inventory + strategy: `strategyMode`, `maxOpenInventorySeconds`
- Signals + EV: `signalMode`, `nearZeroFeeBps`, `evEdgeRequired`, `evFeeBps`, `evMaxEdge`, `evConfidenceMin`, `evConfidenceMinFloor`, `evMaxPerMarketNotional`, `evMaxPortfolioNotional`, `evCooldownSeconds`, `evModelMode`, `evModelRefreshMinutes`, `evCalibrationMethod`, `evModelConfidenceFloor`, `evWebSearchProviderPolicy`, `evWebSearchRefreshMinutes`, `evWebSearchExaEnabled`, `evWebSearchFirecrawlEnabled`, `evWebSearchSerperEnabled`, `evWebSearchGdeltEnabled`, `evWebSearchExaFallbackEnabled`, `evWebSearchLookbackDays`, `evWebSearchMaxResults`, `evWebSearchCacheTtlSeconds`, `evWebSearchMaxConcurrency`, `evWebSearchDefaultContentBudget`, `evWebSearchHighPriorityContentBudget`, `evWebSearchDefaultQueryMode`, `evWebSearchNearResolutionMinutes`, `evWebSearchPriceMoveTriggerBps`, `evWebSearchOfficialDomainRequired`, `evWebSearchGdeltRefreshMinutes`, `evWebSearchGdeltTriggerThreshold`, `evWebSearchExaInlineContentsEnabled`, `evWebSearchExaInlineContentsMaxResults`, `evWebSearchFirecrawlMaxDepth`, `evWebSearchFirecrawlMaxPages`
  - `signalMode=near_zero` disables EV signals; `signalMode=ev` disables near-zero arbitrage.
  - `nearZeroFeeBps` is used by near-zero runtime gating (`evaluateGatesWithFees`) to enforce net-edge profitability after taker fees.
  - `evWebSearchProviderPolicy` is the router ownership point. `gdelt_serper_exa` is the full tiered path, while `exa_only`, `serper_only`, and `serper_exa` are direct fallbacks.
  - `evWebSearchRefreshMinutes` controls `SignalAggregatorAgent` polling cadence and market-metadata cache TTL; it no longer reuses `evModelRefreshMinutes`.
  - `evWebSearchDefaultContentBudget` and `evWebSearchHighPriorityContentBudget` replace the old hardcoded content expansion cap with route-specific limits.
  - `evWebSearchExaInlineContentsEnabled` and `evWebSearchExaInlineContentsMaxResults` control when Exa search responses seed content directly, avoiding a separate `/contents` call inside the bundled-result window.
- Execution safety gates: `rejectDelayed`, `maxDecisionLatencyMs`, `maxDelayedAckRate`, `minPairedFillRate`, `minEdgeTicks`
- Depth/slippage gates: `depthHeadroomFraction`, `depthBufferMultiplier`, `minDepthLevels`, `entrySlippageToleranceBps`, `priceBandBps`
  - `depthBufferMultiplier=0` disables the extra depth buffer requirement.
- Velocity/OTR throttles: `maxOrdersPerMinute`, `orderVelocityWindowMs`, `maxOrderToTradeRatio`, `orderToTradeWindowMs`
- Execution timeouts: `submitTimeoutMs`, `ackTimeoutMs`, `fillTimeoutMs`, `cancelTimeoutMs`
  - `fillTimeoutMs` must be > 0 in `near_zero_risk` mode; `0` skips waiting for user fills (optimistic completion).
- Fallback market metadata (used only when venue data missing): `fallbackTickSize`, `fallbackMinOrderSize`
- FW projection + execution:
  - Dependency/oracle: `fwDependencyMode`, `fwDependencyHybridMerge`, `fwDependencyMinConfidence`, `fwDependencyMaxEdgesPerMarket`, `fwDependencyCacheTtlMs`, `fwDependencyCacheGraceMs`, `fwDependencyCacheMaxEntries`, `fwDependencyBackoffInvalidMs`, `fwDependencyBackoffTimeoutMs`, `fwDependencyBackoffErrorMs`, `fwOracleTimeLimitMs`, `fwOracleMaxConcurrency`
    - `fwDependencyMode=deterministic` removes LLM dependency extraction from the FW hot path and is the safest low-latency default for paper/live rollout.
    - `fwDependencyMode=hybrid` should be used only when dependency extractor cache/backoff controls are enabled and monitored.
    - `fwDependencyHybridMerge` is only meaningful in `hybrid`; validation requires `consensus` for non-hybrid modes.
  - Fully-corrective loop: `fwMaxIterations`, `fwMaxLoopRuntimeMs`, `fwGapAbsTolerance`, `fwGapRelTolerance`, `fwRequireConverged`, `fwContractionInitialEpsilon`, `fwContractionDecay`, `fwContractionMinEpsilon`, `fwStallIterationLimit`, `fwActiveSetMaxVertices`, `fwHullSolveMaxIterations`, `fwHullSolveTolerance`
    - `fwRequireConverged=true` forces both single-market and basket FW intents to carry converged loop diagnostics through emission and downstream re-gating.
    - `fwRequireConverged=false` keeps the approximate-iterate fallback available for exploratory profiles such as `extra_high`.
    - Preset intent: `near_zero`, `moderate`, and `high` set `fwRequireConverged=true`; `extra_high` sets `fwRequireConverged=false`.
  - Projection/risk bounds: `fwMaxProjectionAgeMs`, `fwSlippageToleranceBps`, `fwExecutionRiskBufferBps`, `fwMinEdgeThreshold`, `fwSelectionWeightFloor`, `fwSelectionTopK`, `fwMaxPerMarketNotional`, `fwMaxPortfolioNotional`
  - Basket execution: `fwBasketMinMarkets`, `fwBasketMaxMarkets`, `fwBasketExecutionMode`
  - Basket validation notes:
    - Phase 1 uses pair-buy basket legs only (YES+NO buy per selected market).
    - `fwBasketMinMarkets` must be `<= fwBasketMaxMarkets`.
    - Effective Phase 1 max leg count is derived as `2 * fwBasketMaxMarkets`.

### `risk` (RiskConfig)

- Sizing + exposure: `targetTradeFraction`, `maxTradeFraction`, `maxMarketExposureFraction`
- Loss bounds: `maxAttemptLossFraction`, `maxDailyDrawdownFraction`, `dailyLossLimitFraction`
  - `maxDailyDrawdownFraction=0` disables the drawdown check (daily loss limit still applies if set).
- Circuit breaker behavior: `marketCooldownSeconds`, `marketCircuitFailureThreshold`, `marketCircuitHalfOpenSuccesses`
- Unwind constraints: `maxUnwindLossFraction`, `maxUnwindLossTicks`, `unwindSlippageToleranceBps`, `maxPerTradeLossDollars`

## Dashboard UI (env-only, build-time)

These are set via `dashboard/.env.example` and are not editable at runtime:

- Ops connectivity: `VITE_OPS_BASE_URL` (auth token is entered at runtime via `/ops/*` session login)
- Polling: `VITE_PORTFOLIO_REFRESH_MS`, `VITE_SLO_REFRESH_MS`
- Incidents UI: `VITE_INCIDENTS_LIMIT`, `VITE_INCIDENTS_PREVIEW_LIMIT`

## Runtime (env-only, infra/ops/connectivity)

All infra knobs are env-only; the dashboard shows a read-only snapshot via `GET /config/infra`.

Use `.env.example` for the full list; the most operationally relevant groups are:

- Runtime/ops API: `PORT`, `OPS_API_ENABLED`, `OPS_API_HOST`, `OPS_API_TOKEN`, `OPS_DEV_SESSION_PREFILL_ENABLED` (dev-only localhost token prefill for `/ops/session?prefill=1`)
- Ops behavior: `OPS_HEALTH_INTERVAL_MS`, `OPS_STREAM_HEARTBEAT_MS`, `OPS_INCIDENTS_LIMIT`, `OPS_SHUTDOWN_TIMEOUT_MS`
- Book refresh + stale quarantine: `OPS_BOOK_REFRESH_INTERVAL_MS`, `OPS_BOOK_REFRESH_STALE_MS`, `OPS_BOOK_STALE_QUARANTINE_THRESHOLD`, `OPS_BOOK_STALE_QUARANTINE_WINDOW_MS`, `OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS` (0 = use risk cooldown)
- Reconciliation: `OPS_RECONCILIATION_INTERVAL_MS`, `OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS`, `OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE`
- Telemetry persistence: `EVENT_STORE_PATH`, `EVENT_STORE_METRICS_RETENTION_DAYS`, `EVENT_STORE_METRICS_PRUNE_INTERVAL_MS`
- Polymarket endpoints + rate limiting: `POLYMARKET_CLOB_*`, `POLYMARKET_WS_*`, `POLYMARKET_USER_WS_URL`
- Polymarket auth derivation: `POLYMARKET_L1_PRIVATE_KEY`, `POLYMARKET_L1_NONCE` (optional; derive API creds at boot)
- Market catalog filters: `MARKET_CATALOG_PATH`, `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS`, `MARKET_CATALOG_MIN_VOLUME_24H`, `MARKET_CATALOG_MAX_SPREAD`, `MARKET_CATALOG_PAGE_SIZE`, `MARKET_CATALOG_MAX_PAGES`, `MARKET_CATALOG_ORDER`, `MARKET_CATALOG_EXCLUDE_ENDED_MARKETS`, `MARKET_CATALOG_EXPLORATION_*`, `MARKET_CATALOG_PRESTART_MAX_AGE_MS`
- EV web search (router providers + utility clients): `EXA_*` (including `EXA_COOLDOWN_MS`, `EXA_COOLDOWN_FAILURE_THRESHOLD`), `SERPER_*`, `GDELT_BASE_URL`, `FIRECRAWL_*`, `EV_WEBSEARCH_*`
- FW oracle sidecar connectivity: `FW_ORACLE_BASE_URL`, `FW_ORACLE_TIMEOUT_MS`, `FW_ORACLE_API_KEY`, `FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD`, `FW_ORACLE_CIRCUIT_COOLDOWN_MS`
  - Paper-mode startup contract: when `TRADING_MODE=paper` and `TRADING_ENABLED=true`, backend startup fails fast if `${FW_ORACLE_BASE_URL}/health` is unavailable.
  - Preferred paper orchestration commands: `npm run paper:up`, `npm run paper:status`, `npm run paper:down` (aliases of `dev:ops` commands).
- RPC providers + wait defaults: `*_RPC_URL`, `*_WS_URL`, `*_RPC_RPS`, `RPC_RATE_LIMIT_WINDOW_MS`, `RPC_WAIT_CONFIRMATIONS`, `RPC_WAIT_TIMEOUT_MS`, `RPC_CIRCUIT_*`
- Live trading credentials: `ALCHEMY_API_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_POSITIONS_USER`

## Health endpoints

- Liveness: `GET /health/live` (used by Docker healthcheck)
- Readiness: `GET /health/ready` (for orchestrators; returns `503` when degraded)

## Low-Risk Rollout Guidance

- Catalog spread correctness:
  - `MARKET_CATALOG_MAX_SPREAD` default is `0.02`.
  - Recommended starting range: `0.015` to `0.03`.
- Dual-pass catalog discovery:
  - Default is enabled with bounded exploration:
    - `MARKET_CATALOG_EXPLORATION_ENABLED=true`
    - `MARKET_CATALOG_EXPLORATION_MAX_PAIRS=30`
    - `MARKET_CATALOG_EXPLORATION_MAX_PAGES=3`
    - `MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H=1000`
  - Keep `MARKET_CATALOG_PAGE_SIZE=100` unless Gamma paging behavior requires adjustment.
- Ended-market exclusion:
  - `MARKET_CATALOG_EXCLUDE_ENDED_MARKETS=false` by default.
  - Set to `true` to drop markets whose end timestamp has passed.
- Prestart freshness gate:
  - `MARKET_CATALOG_PRESTART_MAX_AGE_MS=21600000` (6h) by default.
  - `0` forces overwrite refresh on every prestart run.
- Exa cooldown controls:
  - `EXA_COOLDOWN_MS` controls auth/billing backoff window after `401/402`.
  - `EXA_COOLDOWN_FAILURE_THRESHOLD` controls consecutive `401/402` count required before cooldown starts.
- Metrics to watch during rollout:
  - Catalog funnel and source split: `info` events with `message=market_catalog_funnel` and `message=market_catalog_refreshed` (`discoveredCore`, `discoveredExploration`).
  - Exa cooldown events: `web_search` events `provider_cooldown_started`, `provider_cooldown_skip`, `provider_cooldown_recovered`.
  - Active-pair filtering in websearch: `web_search` event `active_pair_skip_allowlist`.
