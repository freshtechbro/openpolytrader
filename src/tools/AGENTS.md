# Tooling

## Scope
Applies to `src/tools/`.

## Responsibilities
- CLI helpers for market catalog generation and prestart checks.

## Rules
- Keep CLI output deterministic and script-friendly.
- Validate inputs and surface actionable errors.

## Tests
- `npm run test -- tests/unit/market-catalog-cli.test.ts`
- `npm run test -- tests/unit/market-catalog-generator.test.ts`
- `npm run test -- tests/unit/market-catalog-prestart-defaults.test.ts`
