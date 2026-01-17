# Dashboard Lib

## Scope
Applies to `dashboard/src/lib/`.

## Responsibilities
- Shared utilities and API client helpers.

## Rules
- Centralize base URL/auth handling in `opsClient`.
- Avoid hard-coded URLs; rely on env configuration.

## Tests
- `npm run test:e2e` (from `dashboard/`).
