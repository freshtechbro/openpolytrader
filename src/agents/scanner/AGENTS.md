# Scanner Agent

## Scope
Applies to `src/agents/scanner/`.

## Responsibilities
- Detect arbitrage opportunities from market data and order books.
- Emit `opportunity:detected` events with gate reasons and metadata.

## Rules
- Respect allowlist status and market catalog constraints.
- Keep scoring deterministic unless explicitly in advisory mode.
- Include enough detail for downstream risk gates to reproduce decisions.

## Tests
- `npm run test -- tests/unit/scanner-llm.test.ts`
- `npm run test -- tests/unit/allowlist.test.ts`
- `npm run test -- tests/unit/gates.test.ts`
