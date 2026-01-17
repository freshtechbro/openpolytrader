# Dashboard Source

## Scope
Applies to `dashboard/src/`.

## Responsibilities
- React UI for ops monitoring, config edits, and risk profiles.
- Use `opsClient` for API calls and `useEventStream` for SSE.

## Rules
- Reuse shared components (`Section`, `Panel`, `MetricsTable`, `StatusPill`).
- Keep schema-driven forms aligned with `/config/schema`.
- Update `docs/Development/dashboard-ui-handoff.md` when UI behavior changes.

## Tests
- `npm run test:e2e` (from `dashboard/`)
