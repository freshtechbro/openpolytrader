# Dashboard Components

## Scope
Applies to `dashboard/src/components/`.

## Responsibilities
- Maintain reusable UI primitives and layouts.

## Rules
- Keep components presentational and stateless when possible.
- Use TypeScript props interfaces for each component.
- Avoid ad-hoc styling; prefer shared CSS tokens.

## Tests
- `npm run test -- tests/unit/dashboard-components.test.ts tests/unit/dashboard-layouts.test.ts`
- `npm --prefix dashboard run test:e2e`
