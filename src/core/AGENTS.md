# Core Infrastructure

## Scope
Applies to `src/core/`.

## Responsibilities
- Orchestrate agent lifecycle, message bus routing, and event sourcing.
- Preserve deterministic state rebuilds and idempotency.

## Rules
- Keep MessageBus event names stable and typed.
- Ensure Supervisor transitions are explicit and logged.
- Persist state via EventStore; avoid ad-hoc filesystem writes.

## Tests
- `npm run test -- tests/unit/supervisor-reconciliation.test.ts`
- `npm run test -- tests/unit/supervisor-assembly.test.ts`
- `npm run test -- tests/unit/message-bus.test.ts`
- `npm run test -- tests/unit/event-store.test.ts`
- `npm run test -- tests/unit/event-store-recovery.test.ts`
- `npm run test -- tests/unit/state-rebuilder.test.ts`
- `npm run test -- tests/unit/trading-state-manager.test.ts`
- `npm run test -- tests/unit/main-shutdown.test.ts`
