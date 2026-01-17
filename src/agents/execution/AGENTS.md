# Execution Agent

## Scope
Applies to `src/agents/execution/`.

## Responsibilities
- Manage the paired execution state machine and idempotent order placement.
- Handle unwind flows safely with bounded loss and deterministic timeouts.
- Emit execution lifecycle events and outcomes.

## Rules
- Preserve idempotency guarantees and nonce reuse across retries.
- Never retry failed orders without a fresh book check (single-shot policy).
- Unwind pricing must respect `maxUnwindLossTicks` and `unwindSlippageToleranceBps`.
- Keep `execution:outcome` and `execution:fill` payloads consistent when changing logic.

## Tests
- `npm run test -- tests/unit/execution.test.ts`
- `npm run test -- tests/unit/execution-user-channel.test.ts`
- `npm run test -- tests/unit/execution-llm-hints.test.ts`
