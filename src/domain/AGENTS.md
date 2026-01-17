# Domain Layer

## Scope
Applies to `src/domain/`.

## Responsibilities
- Pure business logic: state machines, gates, math, and type guards.
- Keep domain logic deterministic and side-effect free.

## Rules
- No I/O or network access in domain modules.
- Avoid hidden globals; pass inputs explicitly.
- Add tests for any new gate or state transition.

## Tests
- `npm run test -- tests/unit/gates.test.ts`
- `npm run test -- tests/unit/domain-utils.test.ts`
- `npm run test -- tests/unit/sequence.test.ts`
