# Backend Source

## Overview

TypeScript backend implementing agent-based arbitrage trading system with event-sourced state.

## Structure

```
src/
├── agents/           # Trading logic agents
│   ├── execution/    # Order execution state machine (HOTSPOT: 1557 lines)
│   ├── portfolio/    # Position/PnL management (531 lines)
│   ├── scanner/      # Opportunity detection
│   ├── risk/         # Risk gate evaluation
│   ├── ops/          # Ops API agent
│   ├── market-data/  # Market data processing
│   └── learning/     # Trade telemetry (write-only)
├── core/             # Infrastructure
│   ├── Supervisor.ts # Agent orchestration (545 lines)
│   ├── MessageBus.ts # Typed event-driven communication
│   └── EventStore.ts # SQLite event sourcing
├── domain/           # Business logic (14 files)
├── services/         # External integrations (8 files)
├── config/           # Environment, policy, risk (12 files)
├── venues/           # Exchange adapters
├── telemetry/        # Metrics, SLO monitoring
├── security/         # Auth utilities
├── api/              # Fastify server
└── db/               # Migrations
```

## Agent Flow

```
ScannerAgent → RiskAgent → ExecutionAgent → PortfolioAgent
     ↓             ↓              ↓               ↓
  Detects      Validates     Executes        Reconciles
  opportunity  gates         orders          positions
```

Events: `market:updated` → `opportunity:detected` → `risk:approved` → `execution_lifecycle` → `fill:applied`

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

States: `idle` → `submitting` → `yes_pending` → `both_acked` → `yes_filled` → `both_filled` → `complete`

Recovery: `partial_fill` → `unwinding` → `unwind_complete`/`unwind_failed`

Terminal: `complete`, `failed`, `timeout`, `cancelled`

Use `getRequiredAction()` for next step in state machine.

## Conventions

- Constructor DI with optional defaults
- EventEmitter for real-time services
- Pure functions for calculations
- Event-sourced state changes (not direct mutation)
- Explicit failure reasons in arrays
- No Zod schemas in domain; type guards for validation
