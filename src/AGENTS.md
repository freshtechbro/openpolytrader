# Backend Source

## Overview

TypeScript backend implementing agent-based arbitrage trading system with event-sourced state.

## Strategy Snapshot

Runtime strategy types (`src/domain/opportunity.ts`) and their distinguishing behavior:

| Strategy type | Distinguishing behavior | Primary policy controls |
| --- | --- | --- |
| `near_zero` | Paired YES/NO arbitrage flow with strict two-leg gate constraints. | `strategyMode`, `signalMode`, `edgeRequired`, `minPairedFillRate`, `maxLegSkewMs` |
| `ev` | Single-sided directional opportunity (`side=yes|no`) driven by calibrated confidence/edge checks. | `signalMode`, `evEdgeRequired`, `evConfidenceMin`, `evCooldownSeconds`, `evMaxPerMarketNotional`, `evMaxPortfolioNotional` |
| `fw_projection` | Dependency-aware Frank-Wolfe projection candidate; only solver-valid outputs are actionable. | `fwDependency*`, `fwGapAbsTolerance`, `fwGapRelTolerance`, `fwMaxLoopRuntimeMs`, `fwMinEdgeThreshold` |
| `fw_basket` | Multi-market FW basket opportunity with explicit basket sizing and execution mode. | `fwBasketExecutionMode`, `fwBasketMinMarkets`, `fwBasketMaxMarkets`, `fwMaxPerMarketNotional`, `fwMaxPortfolioNotional` |

## Structure

```
src/
├── agents/           # Runtime agents plus dependency/projection helpers
├── api/              # Fastify contracts, route handlers, session helpers
├── boot/             # Runtime assembly and startup lifecycle
├── config/           # Split env loaders, policy/risk, RPC, profile store
├── core/             # Supervisor, MessageBus, EventStore, lifecycle infra
├── db/               # SQLite schema + migrations
├── domain/           # Pure business logic, gates, math, shared contracts
├── security/         # Auth utilities
├── services/         # Polymarket, market catalog, LLM, web-search, sidecars
├── telemetry/        # Metrics, SLO streams, telemetry events
├── tools/            # CLI entrypoints and prestart helpers
├── utils/            # Shared helpers
└── venues/           # Exchange adapters
```

## Local Instructions

Local `AGENTS.md` files in subdirectories refine these rules for specific areas:
- `src/agents/**/AGENTS.md` for each agent
- `src/api/AGENTS.md`, `src/config/AGENTS.md`, `src/core/AGENTS.md`
- `src/db/AGENTS.md`, `src/domain/AGENTS.md`, `src/security/AGENTS.md`
- `src/services/AGENTS.md`, `src/telemetry/AGENTS.md`, `src/tools/AGENTS.md`
- `src/utils/AGENTS.md`, `src/venues/AGENTS.md`

Read the nearest `AGENTS.md` before editing files in that subtree.

## Agent Flow

```
SignalAggregatorAgent → ScannerAgent → (optional) FwProjectionAgent → RiskAgent → ExecutionAgent → PortfolioAgent
```

Events: `market:updated` → `opportunity:detected` → `fw_projection` (optional) → `risk:approved` → `execution:outcome` (bus) + `execution_lifecycle` (metrics)

## Domain Layer

| File | Purpose |
|------|---------|
| `types.ts` | Core types: Side, OrderType, OrderPlacement |
| `market.ts` | MarketPair, binary YES/NO tokens |
| `opportunity.ts` | ArbitrageOpportunity, edge calculation |
| `execution.ts` | PairedExecutionState machine (17 states) |
| `dependency.ts` | Dependency edges and market graph models |
| `portfolio.ts` | Position, PortfolioSnapshot |
| `orderbook.ts` | Normalization, depth, sweep cost |
| `gates.ts` | Risk gate evaluation (edge, depth, staleness) |
| `incident.ts` | Failure classification |
| `allowlist.ts` | Market access control (allowed/quarantined/blocked) |
| `idempotency.ts` | Duplicate prevention with nonces |
| `feeModel.ts` | Fee calculations, net edge |
| `venue.ts` | Venue-specific abstractions |
| `contractMapper.ts` | Canonical contract ID mapping |
| `sequence.ts` | Exchange timestamp validation |
| `llm.ts` | LLM analysis contracts and payload schemas |

## Services

| Service | Role |
|---------|------|
| `PolymarketClob` / `PolymarketRealtime` / `PolymarketDataApi` | Exchange REST/WS/portfolio clients |
| `PolymarketAuth` / `PolymarketApiCreds` / `PolymarketUrls` | Auth and endpoint helpers |
| `PolygonRpc` | Blockchain via ethers |
| `RateLimiter` | Sliding window throttle |
| `RetryPolicy` | Exponential backoff |
| `IncidentTracker` | Failure logging |
| `MarketCatalog*` | Catalog loading, refresh, metadata/book helpers |
| `AgentLlm`, `LLMRouter`, provider clients | Advisory model routing and logging |
| `ExaClient`, `FirecrawlClient`, `WebSearch*` | Search providers, cache, runtime normalization |
| `IpOracleClient` | Public IP discovery for sidecar networking checks |

## Execution State Machine

States: `idle` → `submitting` → `yes_pending`/`no_pending`/`both_pending` → `yes_acked`/`no_acked`/`both_acked` → `yes_filled`/`no_filled`/`both_filled` → `complete`

Recovery: `partial_fill` → `unwinding` → `unwind_complete`/`unwind_failed`

Terminal: `complete`, `failed`, `timeout`, `cancelled`

Use `getRequiredAction()` for next step in state machine.

## Conventions

- Constructor DI with optional defaults
- EventEmitter for real-time services
- Pure functions for calculations
- Event-sourced state changes (not direct mutation)
- Explicit failure reasons in arrays
- Minimize runtime schema use in domain; Zod is currently used for LLM payload validation in `src/domain/llm.ts`

## Live Dev

Run from repo root for interactive testing with Docker backend + dashboard:

```bash
npm run help
npm run dev:live
npm run dev:live:down
npm run catalog:refresh:dev -- --help
```
