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
