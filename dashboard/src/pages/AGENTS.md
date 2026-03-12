# Dashboard Pages

## Scope
Applies to `dashboard/src/pages/`.

## Responsibilities
- Route-level views and data fetching.

## Rules
- Use `opsClient` for API calls; avoid direct `fetch` usage.
- Keep forms schema-driven; rely on server-side schema validation for PATCH/POST and add client-side validation where practical.
- Preserve loading/error states for all network calls.

## Tests
- `npm run test -- tests/unit/dashboard-pages.test.ts tests/unit/dashboard-risk-pages.test.ts tests/unit/dashboard-decision-sections.test.ts`
- `npm --prefix dashboard run test:e2e`
