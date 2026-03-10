# Unit Tests

## Scope
Applies to `tests/unit/`.

## Responsibilities
- Fast, isolated tests covering runtime/boot flows, domain logic, dashboard controllers, CLI tooling, and service boundaries.

## Rules
- Use `vi.mock()` only for external dependencies.
- Keep fixtures in `tests/fixtures` when shared.

## Commands
- `npm run test -- tests/unit/<file>.test.ts`
- `npm run test -- tests/unit/dashboard-*.test.ts`
- `npm run test -- tests/unit/runtime-*.test.ts`
- `npm run test:coverage`
