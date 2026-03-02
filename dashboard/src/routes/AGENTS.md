# Dashboard Routes

## Scope
Applies to `dashboard/src/routes/`.

## Responsibilities
- Top-level route composition for public and ops surfaces.
- Session-bound navigation behavior for `/ops/*` pages.

## Rules
- Keep route paths canonical and aligned with navigation links.
- Preserve auth/session checks before protected ops views render.
- Centralize layout-level data loading and unauthorized handling.

## Tests
- `npm --prefix dashboard run test:e2e`
