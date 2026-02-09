# Backend Source

## Overview

TypeScript backend implementing agent-based arbitrage trading system with event-sourced state.

## Structure

```
src/
├── agents/           # Trading logic agents
│   ├── execution/    # Order execution state machine (HOTSPOT: 2229 lines)
│   ├── portfolio/    # Position/PnL management (638 lines)
│   ├── scanner/      # Opportunity detection
│   ├── risk/         # Risk gate evaluation
│   ├── ops/          # Ops API agent
│   ├── market-data/  # Market data processing
│   ├── signal/       # Signal aggregation and web search insights
│   └── learning/     # Trade telemetry + advisory insights
├── core/             # Infrastructure
│   ├── Supervisor.ts # Agent orchestration (1007 lines)
│   ├── MessageBus.ts # Typed event-driven communication
│   └── EventStore.ts # SQLite event sourcing
├── domain/           # Business logic (15 files + AGENTS.md)
├── services/         # External integrations (13 files + AGENTS.md)
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
ScannerAgent → RiskAgent → ExecutionAgent → PortfolioAgent
     ↓             ↓              ↓               ↓
  Detects      Validates     Executes        Reconciles
  opportunity  gates         orders          positions
```

Events: `market:updated` → `opportunity:detected` → `risk:approved` → `execution:outcome` (bus) + `execution_lifecycle` (metrics)

## Domain Layer

| File | Purpose |
|------|---------|
| `types.ts` | Core types: Side, OrderType, OrderPlacement |
| `market.ts` | MarketPair, binary YES/NO tokens |
| `opportunity.ts` | ArbitrageOpportunity, edge calculation |
| `execution.ts` | PairedExecutionState machine (17 states) |
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
npm run dev:live
npm run dev:live:down
```
