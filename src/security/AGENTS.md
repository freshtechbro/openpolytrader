# Security

## Scope
Applies to `src/security/`.

## Responsibilities
- Authentication helpers and secret handling.

## Rules
- Never log or persist secrets.
- Enforce base URL rules for RPC endpoints.

## Tests
- `npm run test -- tests/unit/security.test.ts`
- `npm run test -- tests/unit/polymarket-auth.test.ts`
