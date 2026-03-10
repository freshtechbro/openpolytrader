# Dashboard Source

## Scope
Applies to `dashboard/src/`.

## Responsibilities
- React UI for public product pages plus ops monitoring, config edits, and risk profiles.
- Use `opsClient` for API calls and `useEventStream` for SSE.
- Keep public pages and ops pages split cleanly across route-level controllers and view components.

## Rules
- Reuse shared components (`Section`, `Panel`, `MetricsTable`, `StatusPill`).
- Keep schema-driven forms aligned with `/config/schema`.

## Tests
- `npm run test -- tests/unit/dashboard-*.test.ts`
- `npm run test -- tests/unit/dashboard-controller-direct.test.ts tests/unit/dashboard-ops-route-helpers.test.ts`
- `npm --prefix dashboard run test:e2e`
