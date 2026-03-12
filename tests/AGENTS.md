# Testing

## Overview

Vitest for backend (>97% thresholds across lines/functions/statements/branches), Playwright for dashboard e2e.

## Structure

```
tests/
├── unit/           # 144 backend + dashboard unit suites
└── fixtures/       # shared fixture payloads

dashboard/tests/
└── e2e/            # Playwright specs (*.spec.ts, 5 files)
```

## Local Instructions

Local `AGENTS.md` files refine these rules:
- `tests/fixtures/AGENTS.md`
- `tests/fixtures/llm/AGENTS.md`
- `tests/unit/AGENTS.md`
- `dashboard/tests/AGENTS.md`
- `dashboard/tests/e2e/AGENTS.md`

## Coverage Requirements

Thresholds from `vitest.config.ts`:
- lines: 97.01%
- functions: 97.01%
- statements: 97.01%
- branches: 97.01%

Excluded from coverage:
- `src/main.ts` (entry point)
- `src/boot/runtime.ts` (runtime bootstrap orchestration)
- See `vitest.config.ts` for the full exclusion list (includes selected services, agents, and domain files)

## Naming

| Type | Pattern | Example |
|------|---------|---------|
| Unit | `*.test.ts` | `execution.test.ts` |
| E2E | `*.spec.ts` | `smoke.spec.ts` |

## Commands

```bash
npm run help           # root command/tool/flag reference
npm run test           # vitest run
npm run test:coverage  # with >97% thresholds

npm --prefix dashboard run test:e2e

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

### File-System Cleanup
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
| `execution.test.ts` | 3174 | ExecutionAgent state machine |
| `execution-helper-runners.test.ts` | 2502 | Split execution runners and timeout paths |
| `llm-services.test.ts` | 2320 | Provider routing, retry, and logging paths |
| `portfolio.test.ts` | 1283 | PortfolioAgent reconciliation |
| `gates.test.ts` | 1025 | Risk gates |

## Anti-Patterns

- Don't mock internal runtime flows in broad end-to-end validations without justification
- Don't delete failing tests to "pass"
- Don't skip coverage on critical paths
- Don't use `as any` to bypass type errors in tests
