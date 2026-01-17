# Testing

## Overview

Vitest for backend (95% coverage), Playwright for dashboard e2e.

## Structure

```
tests/
├── unit/           # 38 test files
└── integration/    # 3 test files

dashboard/tests/
└── e2e/            # Playwright specs (*.spec.ts)
```

## Local Instructions

Local `AGENTS.md` files refine these rules:
- `tests/unit/AGENTS.md`
- `tests/integration/AGENTS.md`
- `dashboard/tests/AGENTS.md`
- `dashboard/tests/e2e/AGENTS.md`

## Coverage Requirements

**95% threshold** on lines, functions, statements, branches.

Excluded from coverage:
- `src/main.ts` (entry point)
- External service mocks

## Naming

| Type | Pattern | Example |
|------|---------|---------|
| Unit | `*.test.ts` | `execution.test.ts` |
| Integration | `*.test.ts` | `event-store.test.ts` |
| E2E | `*.spec.ts` | `smoke.spec.ts` |

## Commands

```bash
npm run test           # vitest run
npm run test:coverage  # with 95% thresholds

cd dashboard
npm run test:e2e       # Playwright

# Live (from repo root)
npm run dev:live       # Docker backend + dashboard dev server
npm run dev:live:down  # Stop Docker backend
```

## Patterns

### Unit Tests
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Module', () => {
  beforeEach(() => { /* setup */ });
  afterEach(() => { vi.clearAllMocks(); });
  
  it('should do X', () => {
    expect(result).toBe(expected);
  });
});
```

### Mocking External Services
```typescript
vi.mock('../services/PolymarketClob', () => ({
  PolymarketClob: vi.fn().mockImplementation(() => ({
    placeOrder: vi.fn().mockResolvedValue({ orderId: '123' })
  }))
}));
```

### Integration Cleanup
```typescript
afterEach(() => {
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }
});
```

## Large Test Files

| File | Lines | Coverage |
|------|-------|----------|
| `execution.test.ts` | 1616 | ExecutionAgent state machine |
| `portfolio.test.ts` | 1178 | PortfolioAgent reconciliation |
| `gates.test.ts` | 402 | Risk gates |

## Anti-Patterns

- Don't mock internal systems in integration tests without justification
- Don't delete failing tests to "pass"
- Don't skip coverage on critical paths
- Don't use `as any` to bypass type errors in tests
