# Configuration

## Scope
Applies to `src/config/`.

## Responsibilities
- Define env schema, policy/risk defaults, and config validation.
- Load and persist risk profile selections from JSON.

## Rules
- Any new env key must be added to `src/config/env.ts` and `.env.example`.
- Validate policy/risk changes with `validateP0Config`.
- Keep risk profiles JSON-only and ensure `yes + no < 1` in gate inputs.

## Tests
- `npm run test -- tests/unit/config.test.ts`
- `npm run test -- tests/unit/env-example-coverage.test.ts`
- `npm run test -- tests/unit/config-validate-missing-schema.test.ts`
- `npm run test -- tests/unit/risk-profile-active.test.ts`
