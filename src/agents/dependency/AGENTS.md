# Dependency Resolution Agent Modules

## Scope
Applies to `src/agents/dependency/`.

## Responsibilities
- Resolve dependency graphs used by FW projection.
- Manage deterministic/LLM hybrid dependency extraction behavior.

## Rules
- Keep deterministic fallback available for all dependency modes.
- Bound cache and backoff behavior to avoid hot-path latency spikes.
- Emit reasoned diagnostics for extraction failures/timeouts.

## Tests
- `npm run test -- tests/unit/dependency-resolver.test.ts`
- `npm run test -- tests/unit/dependency-llm-extractor.test.ts`
