# Public Pages

## Scope
Applies to `dashboard/src/pages/public/`.

## Responsibilities
- Public route pages (`/`, `/product`, `/risk-safety`, `/architecture`, `/get-started`).

## Rules
- Keep page copy aligned with backend/runtime capabilities.
- Do not add ops-only data dependencies to public pages.
- Preserve link structure expected by `AppRouter` and `PublicLayout`.

## Tests
- `npm --prefix dashboard run test:e2e`
