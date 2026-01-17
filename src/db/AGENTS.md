# Database

## Scope
Applies to `src/db/`.

## Responsibilities
- Maintain SQLite schema and migrations for event store data.

## Rules
- Keep `src/db/schema.sql` in sync with migrations.
- Use forward-only migrations; never edit applied migrations.

## Tests
- `npm run test -- tests/integration/event-store.test.ts`
