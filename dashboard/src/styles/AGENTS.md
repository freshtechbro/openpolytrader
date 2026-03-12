# Dashboard Styles

## Scope
Applies to `dashboard/src/styles/`.

## Responsibilities
- Maintain design tokens and global layout styles.
- Keep the split app stylesheets (`app-base`, `app-dashboard`, `app-ops`, `app-public`, `app-responsive`) coherent.

## Rules
- Use CSS variables from `tokens.css` for colors/spacing.
- Avoid inline styles in pages/components unless necessary.

## Tests
- `npm run test -- tests/unit/dashboard-layouts.test.ts tests/unit/dashboard-pages.test.ts`
- `npm --prefix dashboard run test:e2e`
