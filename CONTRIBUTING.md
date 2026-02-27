# Contributing to OpenPolyTrader

Thank you for your interest in contributing to OpenPolyTrader! This document provides guidelines and standards for contributing to this Polymarket CLOB arbitrage automation system.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Environment](#development-environment)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing Requirements](#testing-requirements)
- [Agent Architecture Guidelines](#agent-architecture-guidelines)
- [Pull Request Process](#pull-request-process)
- [Commit Message Conventions](#commit-message-conventions)
- [Documentation Requirements](#documentation-requirements)
- [Security Considerations](#security-considerations)
- [Questions and Support](#questions-and-support)

---

## Code of Conduct

- Be respectful and constructive in all interactions
- Focus on technical merit and project goals
- Welcome newcomers and help them learn
- Respect the near-zero-risk philosophy of the project

---

## Development Environment

### Prerequisites

- **Node.js 20+** (required for native ESM support)
- **npm** (comes with Node.js)
- **Git**
- **Docker** (optional, for containerized development)

### Setup Steps

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/freshtechbro/openpolytrader.git
   cd openpolytrader
   ```

2. **Install dependencies:**
   ```bash
   npm install
   cd dashboard && npm install && cd ..
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   # Set OPS_API_TOKEN in .env for npm run dev:ops and /ops/* auth
   # See docs/Development/setup.md for full setup details
   ```

4. **View the root command/tool/flag index:**
   ```bash
   npm run help
   ```

5. **Verify setup:**
   ```bash
   npm run typecheck
   npm run lint
   npm run test
   ```

### Development Modes

- **Backend only:** `npm run dev`
- **Backend + Dashboard:** `npm run dev:ops` (requires `OPS_API_TOKEN`)
- **Docker mode:** `npm run dev:live`

See [docs/Development/setup.md](docs/Development/setup.md) for detailed setup instructions.

---

## Project Structure

```
openpolytrader/
├── src/
│   ├── agents/        # Trading agents (9 specialized agents)
│   │   ├── dependency/  # Dependency extraction helpers
│   │   ├── execution/   # Order execution logic
│   │   ├── learning/    # RL model integration
│   │   ├── market-data/ # WebSocket data handling
│   │   ├── ops/         # Operations and health
│   │   ├── portfolio/   # Position management
│   │   ├── projection/  # Frank-Wolfe projection agent
│   │   ├── risk/        # Risk evaluation
│   │   ├── scanner/     # Opportunity detection
│   │   └── signal/      # Signal aggregation
│   ├── core/          # Supervisor, MessageBus, EventStore
│   ├── domain/        # Business logic, types, gates
│   ├── services/      # External API clients
│   ├── config/        # Environment and policy config
│   ├── venues/        # VenueAdapter abstraction
│   ├── telemetry/     # Metrics and monitoring
│   ├── security/      # Auth and secrets
│   ├── api/           # Fastify ops endpoints
│   ├── db/            # SQLite migrations
│   └── main.ts        # Entry point
├── dashboard/         # React/Vite ops dashboard
├── tests/             # Vitest unit + integration tests
│   ├── unit/          # Unit tests
│   ├── integration/   # Integration tests
│   └── fixtures/      # Test fixtures
├── docs/              # Documentation
│   ├── ARCHITECTURE.md
│   ├── Development/
│   ├── Operations/
│   └── Testing/
└── scripts/           # Utility scripts
```

---

## Coding Standards

### TypeScript Conventions

- **Target:** ES2022 with NodeNext modules
- **Strict mode:** Enabled (no `any`, no `@ts-ignore`)
- **Module system:** ESM (`"type": "module"` in package.json)

```typescript
// ✅ Good: Explicit types, strict mode
interface TradeOpportunity {
  marketId: string;
  yesPrice: number;
  noPrice: number;
  edge: number;
}

function calculateProfit(op: TradeOpportunity): number {
  return op.edge * 100; // percentage
}

// ❌ Bad: Implicit any, ts-ignore
// @ts-ignore
function badFunction(x) {
  return x + 1;
}
```

### Naming Conventions

- **Internal code:** `camelCase`
- **External API fields:** `snake_case`
- **Classes:** `PascalCase`
- **Interfaces:** `PascalCase`
- **Constants:** `UPPER_SNAKE_CASE`
- **Unused variables:** Prefix with `_`

```typescript
// ✅ Good
interface OrderBookEntry {
  price: number;
  size: number;
}

class ExecutionAgent {
  private _unusedVar: string;
  
  processOrder(entry: OrderBookEntry): void {
    // ...
  }
}

// External API mapping
const apiPayload = {
  market_id: marketId,  // snake_case for API
  order_type: 'fok'
};
```

### Code Organization

- **Interfaces** for data structures
- **Classes** for stateful services
- **Functions** for pure logic
- **Zod** for runtime validation

```typescript
// Data interface
interface RiskConfig {
  maxPositionPercent: number;
  dailyDrawdownLimit: number;
}

// Runtime validation
const RiskConfigSchema = z.object({
  maxPositionPercent: z.number().min(0).max(1),
  dailyDrawdownLimit: z.number().min(0).max(1)
});

// Stateful service
export class RiskAgent {
  constructor(private config: RiskConfig) {}
  
  evaluate(opportunity: ArbitrageOpportunity): RiskDecision {
    // Implementation
  }
}
```

---

## Testing Requirements

### Coverage Threshold

**Minimum 97% coverage** is required for all contributions.

```bash
# Run tests with coverage
npm run test:coverage
```

### Test Types

1. **Unit Tests** (`tests/unit/*.test.ts`)
   - Test individual functions/classes in isolation
   - Mock external dependencies with `vi.mock()`
   - Fast, deterministic execution

2. **Integration Tests** (`tests/integration/*.test.ts`)
   - Test multi-component flows
   - Use real internal systems (don't mock unless justified)
   - Isolate external integrations (Polymarket, RPC)

3. **E2E Tests** (`dashboard/tests/e2e/*.spec.ts`)
   - Playwright-based UI testing
   - Test critical user flows

### Testing Best Practices

```typescript
// ✅ Good: Proper test structure
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiskAgent } from '../src/agents/risk/RiskAgent';

// Mock external dependency
vi.mock('../src/services/PolymarketClob', () => ({
  PolymarketClob: vi.fn()
}));

describe('RiskAgent', () => {
  let agent: RiskAgent;
  
  beforeEach(() => {
    agent = new RiskAgent({
      maxPositionPercent: 0.8,
      dailyDrawdownLimit: 0.1
    });
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  it('should approve valid opportunities', () => {
    const opportunity = createMockOpportunity({ edge: 0.03 });
    const decision = agent.evaluate(opportunity);
    expect(decision.approved).toBe(true);
  });
  
  it('should reject opportunities exceeding drawdown limit', () => {
    // Test implementation
  });
});
```

### Test Data

- Use **synthetic orderbooks** for CLOB gateway logic
- Use **fixtures** in `tests/fixtures/` for reusable test data
- Never use real API keys in tests

---

## Agent Architecture Guidelines

### Agent Structure

All agents follow a consistent pattern:

```typescript
export class AgentName {
  constructor(
    private config: AgentConfig,
    private dependencies: AgentDependencies
  ) {}
  
  async start(): Promise<void> {
    // Initialize connections, subscribe to events
  }
  
  async stop(): Promise<void> {
    // Cleanup, close connections
  }
  
  private handleEvent(event: TypedEvent): void {
    // Event handler
  }
}
```

### MessageBus Communication

Agents communicate via the typed MessageBus:

```typescript
// Subscribe to events
MessageBus.on('opportunity:detected', (opportunity) => {
  this.handleOpportunity(opportunity);
});

// Emit events
MessageBus.emit('risk:approved', {
  opportunity,
  positionSize: calculatedSize
});
```

### Event Sourcing

All state changes must be logged to EventStore:

```typescript
await EventStore.append({
  id: generateId(),
  timestamp: Date.now(),
  type: 'execution:order_placed',
  data: orderDetails,
  metadata: { 
    agent: 'ExecutionAgent',
    correlationId: context.correlationId 
  }
});
```

### Idempotency

All operations must be idempotent:

```typescript
// Use deterministic idempotency keys
const idempotencyKey = createHash('sha256')
  .update(`${marketId}-${tokenId}-${price}-${timeBucket}`)
  .digest('hex');
```

---

## Pull Request Process

### Before Submitting

1. **Run all checks:**
   ```bash
   npm run lint
   npm run typecheck
   npm run test:coverage
   ```

2. **Update documentation** if needed

3. **Add tests** for new functionality

4. **Verify no secrets** in code

### PR Requirements

- Clear description of changes
- Link to related issue(s)
- Test coverage report (97%+ required)
- Documentation updates if applicable
- No breaking changes without discussion

### Review Process

1. Automated checks must pass (CI)
2. Code review by maintainer
3. Address feedback promptly
4. Squash commits if requested

---

## Commit Message Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary>

- Detailed bullet points
- What was added/changed/fixed
- Why (if not obvious)
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `test` | Test additions or fixes |
| `refactor` | Code refactoring |
| `perf` | Performance improvements |
| `chore` | Build/config changes |
| `security` | Security fixes |

### Examples

```
feat: add Kalshi venue adapter for Phase 2

- Implement VenueAdapter interface
- Add Kalshi-specific order normalization
- Include fee model in EV calculations

fix: correct orderbook depth calculation

- Use top 3 levels instead of top 1
- Add buffer multiplier for safety
test: add coverage for RiskAgent drawdown logic

- Test daily drawdown limit enforcement
- Test edge cases for partial fills
```

---

## Documentation Requirements

### Code Documentation

- JSDoc for all public methods
- Type annotations for all functions
- Inline comments for complex logic

```typescript
/**
 * Evaluates an arbitrage opportunity against risk parameters.
 * 
 * @param opportunity - The detected arbitrage opportunity
 * @returns Risk decision with approval status and sizing
 * @throws Never throws; returns rejected decision on error
 */
async evaluateOpportunity(
  opportunity: ArbitrageOpportunity
): Promise<RiskDecision> {
  // Implementation
}
```

### Architecture Documentation

Update relevant docs for architectural changes:
- `docs/ARCHITECTURE.md` - System architecture
- `docs/Development/architecture-decisions.md` - New ADRs
- `AGENTS.md` - Project knowledge base

### README Updates

Keep README.md current with:
- New features
- Changed commands
- New dependencies

---

## Security Considerations

### Never Commit

- `.env` files
- API keys or secrets
- Private keys
- Passwords

### Secure Coding

```typescript
// ✅ Good: Environment variables for secrets
const apiKey = process.env.POLYMARKET_API_KEY;
if (!apiKey) {
  throw new Error('POLYMARKET_API_KEY not set');
}

// ❌ Bad: Hardcoded secrets
const apiKey = 'actual-secret-key';
```

### Logging

Never log sensitive data:

```typescript
// ✅ Good: Redact sensitive fields
logger.info('Order placed', {
  marketId: order.marketId,
  size: order.size,
  // apiKey is NOT logged
});

// ❌ Bad: Logging secrets
logger.info('API call', { apiKey, secret });
```

See [docs/Operations/security.md](docs/Operations/security.md) for full security procedures.

---

## Questions and Support

### Getting Help

1. **Documentation:** Check the [docs/](docs/) folder first
2. **AGENTS.md:** Review project knowledge base
3. **Issues:** Search existing GitHub issues
4. **Discussions:** Use GitHub Discussions for questions

### Reporting Bugs

Include:
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS)
- Relevant logs (redact secrets!)

### Feature Requests

- Describe the use case
- Explain the benefit to the project
- Consider implementation complexity

---

## Recognition

Contributors will be recognized in:
- Release notes
- CONTRIBUTORS file
- Project documentation

Thank you for helping make OpenPolyTrader better!
