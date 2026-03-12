# Dashboard Hooks

## Scope
Applies to `dashboard/src/hooks/`.

## Responsibilities
- Encapsulate shared UI state logic (SSE, polling, derived state).

## Rules
- Keep hooks pure and reusable; avoid direct DOM manipulation.
- Ensure cleanup in `useEffect` to prevent leaks.

## Tests
- `npm run test -- tests/unit/dashboard-controller-direct.test.ts tests/unit/dashboard-runtime.test.ts`
- `npm --prefix dashboard run test:e2e`
