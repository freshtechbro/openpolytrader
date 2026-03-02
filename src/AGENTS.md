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
├── agents/           # Specialized agents + dependency/projection modules
│   ├── dependency/   # Dependency extraction + graph resolution helpers
│   ├── execution/    # Order execution state machine (HOTSPOT: 2229 lines)
│   ├── portfolio/    # Position/PnL management (650 lines, 21262 bytes)
│   ├── scanner/      # Opportunity detection
│   ├── risk/         # Risk gate evaluation
│   ├── ops/          # Ops API agent
│   ├── market-data/  # Market data processing
│   ├── projection/   # Frank-Wolfe projection agent
│   ├── signal/       # Signal aggregation and web search insights
│   └── learning/     # Trade telemetry + advisory insights
├── core/             # Infrastructure
│   ├── Supervisor.ts # Agent orchestration (1054 lines, 36589 bytes)
│   ├── MessageBus.ts # Typed event-driven communication
│   └── EventStore.ts # SQLite event sourcing
├── domain/           # Business logic (16 files + AGENTS.md)
├── services/         # External integrations (11 top-level files + nested providers)
├── config/           # Environment, policy, risk (14 files)
├── venues/           # Exchange adapters
├── telemetry/        # Metrics, SLO monitoring
├── security/         # Auth utilities
├── api/              # Fastify server
└── db/               # Migrations
```

## Local Instructions

Local `AGENTS.md` files in subdirectories refine these rules for specific areas:
- `src/agents/**/AGENTS.md` for each agent
- `src/core/AGENTS.md`, `src/domain/AGENTS.md`, `src/services/AGENTS.md`
- `src/config/AGENTS.md`, `src/api/AGENTS.md`, `src/telemetry/AGENTS.md`
- `src/tools/AGENTS.md`, `src/utils/AGENTS.md`, `src/security/AGENTS.md`, `src/venues/AGENTS.md`

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
| `PolymarketClob` | REST API for orders |
| `PolymarketRealtime` | WebSocket market data |
| `PolymarketDataApi` | Positions/portfolio API |
| `PolygonRpc` | Blockchain via ethers |
| `RateLimiter` | Sliding window throttle |
| `RetryPolicy` | Exponential backoff |
| `IncidentTracker` | Failure logging |
| `MarketCatalog` | Market pair loading |
| `MarketCatalogRefresher` | Catalog refresh loop and cadence |
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
