# Testing Strategy

This project follows MCAF verification principles: critical behavior is covered by automated tests, with integration and E2E coverage prioritized over unit-only assertions.

## Test Layers

Coverage gate:
- Global thresholds are enforced in `vitest.config.ts` at `>97%` for lines, functions, statements, and branches.

### Unit Tests (Vitest)
- Target: deterministic logic and gate evaluation.
- Location: `tests/unit/`
- Command: `npm run test`

### Integration Tests (Vitest)
- Target: multi-component flows (ops health checks, metrics emission).
- Location: `tests/integration/`
- Command: `npm run test`

### UI E2E Tests (Playwright)
- Target: ops dashboard smoke coverage.
- Location: `dashboard/tests/e2e/`
- Command:
  1. `cd dashboard`
  2. `npm install`
  3. `npx playwright install --with-deps`
  4. `npm run test:e2e`

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs:
1. Typecheck
2. Unit + integration tests
3. Backend build
4. Dashboard build
5. Dashboard E2E tests

## Test Data Guidance

- Use synthetic orderbooks and mock responses for the CLOB gateway logic.
- Do not mock internal systems in integration tests unless explicitly justified.
- External integrations (Polymarket, RPC) should be isolated in tests; full end-to-end execution requires staging credentials.

## FWMM Verification Matrix

| Behavior | Primary Tests | Command |
| --- | --- | --- |
| FW objective/gradient/hull math stability | `tests/unit/fw-objective.test.ts`, `tests/unit/fw-hull-solver.test.ts`, `tests/unit/fw-loop-engine.test.ts` | `npm run test -- tests/unit/fw-loop-engine.test.ts` |
| FW projection loop convergence + non-converged rejection | `tests/unit/fw-projection-agent.test.ts` | `npm run test -- tests/unit/fw-projection-agent.test.ts` |
| Basket gate validation (per-market + aggregate) | `tests/unit/gates.test.ts` | `npm run test -- tests/unit/gates.test.ts` |
| Basket risk sizing/exposure bounds | `tests/unit/risk.test.ts` | `npm run test -- tests/unit/risk.test.ts` |
| Basket execution modes + fallback behavior | `tests/unit/execution.test.ts` | `npm run test -- tests/unit/execution.test.ts` |
| Supervisor atomic market-set reservations | `tests/unit/supervisor-reconciliation.test.ts` | `npm run test -- tests/unit/supervisor-reconciliation.test.ts` |
| Oracle sidecar iterative contract smoke | `tests/integration/ip-oracle-sidecar-smoke.test.ts` | `npm run test -- tests/integration/ip-oracle-sidecar-smoke.test.ts` |
| FW telemetry counters/event availability | `tests/unit/telemetry.test.ts` | `npm run test -- tests/unit/telemetry.test.ts` |

Rollout safety validation:

- Replay: no execution path invocation for FW outputs.
- Shadow: no order placement while telemetry/reasons remain complete.
- Paper: gap-converged outputs only and unwind/partial-fill incidents within thresholds.

Required release gates for FWMM changes:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:coverage`
- `npm --prefix dashboard run build`
- `npm --prefix dashboard run test:e2e`
