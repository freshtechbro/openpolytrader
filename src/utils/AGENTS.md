# Utilities

## Scope
Applies to `src/utils/`.

## Responsibilities
- Shared helpers for math, crypto, serialization, and concurrency.

## Rules
- Keep helpers pure and side-effect free.
- Add unit tests for any new helper.

## Tests
- `npm run test -- tests/unit/math.test.ts`
- `npm run test -- tests/unit/serialization.test.ts`
- `npm run test -- tests/unit/concurrency.test.ts`
