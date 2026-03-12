# Dashboard Lib

## Scope
Applies to `dashboard/src/lib/`.

## Responsibilities
- Shared utilities and API client helpers.

## Rules
- Centralize base URL/auth handling in `opsClient`.
- Avoid hard-coded URLs; rely on env configuration.

## Tests
- `npm run test -- tests/unit/dashboard-runtime.test.ts tests/unit/no-hardcoded-dashboard-urls.test.ts tests/unit/no-dashboard-import-meta-env.test.ts`
- `npm --prefix dashboard run test:e2e`
