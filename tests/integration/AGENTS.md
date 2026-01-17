# Integration Tests

## Scope
Applies to `tests/integration/`.

## Responsibilities
- Validate multi-component flows (event store, ops agent, LLM shadow).

## Rules
- Avoid mocking internal systems unless explicitly required.
- Clean up temp resources in `afterEach`.

## Commands
- `npm run test -- tests/integration/<file>.test.ts`
- `npm run test:coverage`
