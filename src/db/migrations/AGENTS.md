# Database Migrations

## Scope
Applies to `src/db/migrations/`.

## Responsibilities
- Store forward-only SQL migrations for the event store.

## Rules
- Never edit existing migration files once committed.
- Add new migration files with incremental ordering.

## Tests
- `npm run test -- tests/integration/event-store.test.ts`
