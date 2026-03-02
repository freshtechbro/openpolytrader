# Dashboard Scripts

## Scope
Applies to `dashboard/scripts/`.

## Responsibilities
- Dashboard-local automation scripts (for example smoke/e2e helpers).

## Rules
- Keep scripts deterministic and non-interactive for CI usage.
- Exit non-zero on failure and print concise diagnostics.

## Validation
- Run the script directly and through documented npm wrappers when available.
