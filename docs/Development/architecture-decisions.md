# Architecture Decision Records (ADRs)

This document records significant architectural decisions made in the OpenPolyTrader project, along with their context and consequences.

---

## ADR-001: Agent-Based Architecture

**Date:** 2024-01-15  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed to design a system for high-frequency arbitrage on Polymarket CLOB that could:
- Process market data in real-time
- Make rapid trading decisions
- Handle failures gracefully
- Scale to multiple markets
- Support future multi-venue trading

The initial monolithic approach became complex and hard to test as we added risk checks, execution logic, and portfolio tracking.

### Decision

We chose an **agent-based architecture** with 8 specialized agents:

1. **MarketDataAgent** - WebSocket connection and orderbook management
2. **SignalAggregatorAgent** - EV signal collection and aggregation
3. **ScannerAgent** - Opportunity detection
4. **RiskAgent** - Risk evaluation and capital management
5. **ExecutionAgent** - Order placement and monitoring
6. **PortfolioAgent** - Position tracking and reconciliation
7. **OpsAgent** - Health monitoring and operations
8. **LearningAgent** - RL model integration and insights

Agents communicate via a typed **MessageBus** using events.

### Consequences

**Positive:**
- Clear separation of concerns
- Each agent can be tested in isolation
- Easy to add new agents (e.g., for Phase 2 venues)
- Failure in one agent doesn't cascade
- Event-driven flow matches trading pipeline naturally

**Negative:**
- More complex initial setup
- Need to manage agent lifecycle
- Event ordering requires careful design
- Debugging distributed state is harder

**Neutral:**
- Requires understanding of event-driven patterns
- More files and modules to navigate

---

## ADR-002: Event-Sourced State Management

**Date:** 2024-01-20  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

Trading systems require:
- Complete audit trails for compliance
- Ability to reconstruct state after crashes
- Debugging capabilities for post-trade analysis
- No data loss on system failures

Traditional CRUD approaches lose historical context and make debugging difficult.

### Decision

We chose **event sourcing** with SQLite as the event store:

- All state changes are stored as immutable events
- Current state is derived by replaying events
- Events include metadata (timestamp, agent, correlation ID)
- SQLite provides ACID guarantees and easy backup

```typescript
interface StoredEvent {
  id: string;
  timestamp: number;
  type: string;
  data: any;
  metadata: { agent: string; correlationId?: string };
}
```

### Consequences

**Positive:**
- Complete audit trail for all actions
- Easy to debug by replaying event log
- State can be rebuilt after crashes
- Time-travel debugging possible
- Immutable history prevents accidental data loss

**Negative:**
- More storage required (every change stored)
- Need to implement event replay logic
- Schema evolution requires migration strategy
- Querying current state requires reconstruction

**Neutral:**
- Requires understanding of event sourcing patterns
- Need periodic snapshots for performance

---

## ADR-003: SQLite for Event Store

**Date:** 2024-01-22  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed a persistence layer for:
- Event sourcing (immutable event log)
- Metrics retention
- Incident tracking
- Configuration persistence

Options considered: PostgreSQL, MongoDB, Redis, SQLite.

### Decision

We chose **SQLite** for the event store:

- Single file, zero configuration
- ACID compliant
- Excellent read performance for analytical queries
- Easy backup (just copy the file)
- No separate database server needed
- Good enough write performance for our event volume

### Consequences

**Positive:**
- Zero operational overhead
- Simple deployment (file-based)
- Excellent for single-node deployment
- Great tooling support (DB Browser, CLI)
- ACID guarantees for data integrity

**Negative:**
- Not suitable for multi-node deployment
- Write performance limited by single-file locking
- No built-in replication
- Limited concurrent write throughput

**Neutral:**
- Requires `better-sqlite3` native module
- Need to handle database migrations

---

## ADR-004: TypeScript with Strict Mode

**Date:** 2024-01-10  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed to choose a language for a financial trading system where:
- Type safety is critical (money at stake)
- Rapid development is needed
- Team has JavaScript/TypeScript experience
- Rich ecosystem of libraries available

Options considered: TypeScript (loose), TypeScript (strict), Rust, Go.

### Decision

We chose **TypeScript with strict mode enabled**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

- ES2022 target for modern JavaScript features
- NodeNext modules for ESM support
- Strict mode for maximum type safety
- No `any` types allowed

### Consequences

**Positive:**
- Catches many bugs at compile time
- Excellent IDE support (autocomplete, refactoring)
- Team can leverage existing JS/TS knowledge
- Rich ecosystem (Ethers.js, Fastify, etc.)
- Can gradually add stricter rules

**Negative:**
- Runtime errors still possible (need Zod validation)
- Slower than Rust/Go for CPU-intensive tasks
- Type definitions sometimes lag behind libraries
- Build step required

**Neutral:**
- Need discipline to avoid `as any` casts
- Learning curve for strict type features

---

## ADR-005: Fastify over Express

**Date:** 2024-01-12  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed an HTTP framework for the Ops API that provides:
- High performance (low latency)
- TypeScript support
- Easy plugin ecosystem
- Good logging and hooks
- Schema validation

Options considered: Express, Fastify, Koa, NestJS.

### Decision

We chose **Fastify**:

- 2x faster than Express (critical for low-latency ops)
- Built-in JSON schema validation
- Excellent TypeScript support
- Plugin architecture
- Built-in logging
- Growing ecosystem

```typescript
import fastify from 'fastify';

const app = fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'healthy' };
});
```

### Consequences

**Positive:**
- Better performance than Express
- Schema validation prevents bad requests
- Excellent plugin system
- Built-in metrics and logging
- Active development

**Negative:**
- Smaller ecosystem than Express
- Different plugin model to learn
- Some middleware needs adapters

**Neutral:**
- Team needed to learn Fastify patterns
- Migration from Express patterns required

---

## ADR-006: React + Vite for Dashboard

**Date:** 2024-01-25  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed a dashboard for:
- Real-time monitoring of trading system
- Configuration management
- Incident viewing
- Portfolio tracking

Requirements: Fast development, real-time updates, good DX.

Options considered: React + CRA, React + Vite, Vue, Svelte, vanilla JS.

### Decision

We chose **React 18 + Vite**:

- Vite for instant HMR and fast builds
- React for component model and ecosystem
- No complex state management (useState/useEffect)
- SSE for real-time updates from backend
- CSS variables for theming

### Consequences

**Positive:**
- Excellent developer experience (fast HMR)
- Small bundle size
- Easy to reason about (no Redux/Zustand)
- Real-time updates via SSE
- TypeScript support out of the box

**Negative:**
- Manual state management can get complex
- No built-in component library
- Need to handle reconnection logic for SSE

**Neutral:**
- Team already knew React
- Could migrate to Next.js later if needed

---

## ADR-007: Near-Zero-Risk First Strategy

**Date:** 2024-02-01  
**Status:** Accepted  
**Deciders:** Core Development Team, Risk Committee

### Context

We needed to choose a trading strategy that:
- Minimizes capital risk
- Provides consistent returns
- Can be thoroughly tested
- Builds confidence before expanding

Options considered: EV-based trading, market making, near-zero arbitrage.

### Decision

We chose **near-zero-risk arbitrage as the default strategy**:

- Exploit YES+NO pricing inefficiencies (sum < $1.00)
- Complete set redemption guarantees profit
- Risk profiles from `near_zero` to `extra_high`
- EV signals available but disabled by default
- Conservative execution with strict gates

### Consequences

**Positive:**
- Mathematically bounded risk
- Good for building track record
- Easy to understand and explain
- Fast feedback loop for system validation
- Can enable EV signals when ready

**Negative:**
- Lower profit per trade than EV strategies
- Requires active orderbook on both sides
- Limited to binary markets
- May miss larger opportunities

**Neutral:**
- Requires careful execution to maintain near-zero property
- Need good market selection

---

## ADR-008: Risk Profile System

**Date:** 2024-02-05  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed a way to:
- Adjust risk parameters without code changes
- Support different risk appetites
- Allow runtime risk adjustment
- Persist risk settings across restarts

### Decision

We implemented a **risk profile system**:

- Predefined profiles: `near_zero`, `moderate`, `high`, `extra_high`
- JSON profile files in `settings/risk-gates/`
- Runtime switching via Ops API
- Persistence to `settings/risk-gates/active.json`
- Environment variable override on boot

```typescript
// Risk profile structure
interface RiskProfile {
  name: string;
  targetTradeFraction: number;
  maxTradeFraction: number;
  maxDailyDrawdownFraction: number;
  marketCooldownSeconds: number;
  // ... more parameters
}
```

### Consequences

**Positive:**
- Easy to adjust risk without deployment
- Different profiles for different market conditions
- Safe testing in `shadow` mode with any profile
- Clear risk parameter documentation

**Negative:**
- More complex configuration
- Need to validate profile compatibility
- Risk of misconfiguration

**Neutral:**
- Requires UI for profile management
- Need migration strategy for profile changes

---

## ADR-009: LLM Advisory Mode Only

**Date:** 2024-02-10  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We wanted to leverage LLMs for:
- Market analysis and scoring
- Health summaries
- Learning insights
- Risk assessment

But needed to ensure:
- No autonomous trading decisions
- Human oversight maintained
- Bounded, conservative usage
- Fail-safe behavior

### Decision

We implemented **LLM advisory mode only**:

- LLMs provide recommendations, not decisions
- All LLM outputs logged for review
- Multiple provider support (OpenCode, OpenRouter)
- Per-agent LLM configuration
- Circuit breaker for LLM failures
- Timeout and retry logic

```typescript
// LLM strictly advisory
interface LLMRecommendation {
  confidence: number;
  reasoning: string;
  suggestedAction: string;
  // Human must approve
}
```

### Consequences

**Positive:**
- Human maintains control
- LLM insights can improve decisions
- Safe failure modes
- Configurable per agent
- Audit trail of all LLM interactions

**Negative:**
- Adds latency to decision pipeline
- Cost of LLM API calls
- Need to handle LLM unavailability
- Requires prompt engineering

**Neutral:**
- Can disable LLM per agent if needed
- Can switch providers for cost/performance

---

## ADR-010: ESM Modules

**Date:** 2024-01-08  
**Status:** Accepted  
**Deciders:** Core Development Team

### Context

We needed to choose between CommonJS and ESM for:
- Better tree-shaking
- Native async/await
- Future-proofing
- Compatibility with modern libraries

### Decision

We chose **ESM (ECMAScript Modules)**:

```json
{
  "type": "module"
}
```

- Native `import`/`export` syntax
- Top-level await support
- Better static analysis
- Required by some modern libraries

### Consequences

**Positive:**
- Native async/await at module level
- Better tree-shaking for smaller bundles
- Future-proof (industry direction)
- Cleaner syntax

**Negative:**
- Some older libraries need dynamic import
- Jest/Vitest configuration differences
- Node.js version requirement (20+)
- __dirname/__filename need polyfills

**Neutral:**
- Team needed to learn ESM patterns
- Most modern tools support ESM now

---

## How to Add New ADRs

When making significant architectural decisions:

1. Create a new section following the format above
2. Include date, status, and deciders
3. Document the context (problem being solved)
4. State the decision clearly
5. List all consequences (positive, negative, neutral)
6. Update the table of contents

### ADR Status Definitions

- **Proposed:** Under discussion, not yet decided
- **Accepted:** Decision made, being implemented
- **Deprecated:** Decision reversed, no longer valid
- **Superseded:** Replaced by a newer ADR (link to new one)

---

## Related Documentation

- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [AGENTS.md](../../AGENTS.md) - Project knowledge base
- [docs/Operations/config-knobs.md](../Operations/config-knobs.md) - Configuration reference
