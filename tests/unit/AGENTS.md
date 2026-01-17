# Unit Tests

## Scope
Applies to `tests/unit/`.

## Responsibilities
- Fast, isolated tests covering domain logic and service boundaries.

## Rules
- Use `vi.mock()` only for external dependencies.
- Keep fixtures in `tests/fixtures` when shared.

## Commands
- `npm run test -- tests/unit/<file>.test.ts`
- `npm run test:coverage`
