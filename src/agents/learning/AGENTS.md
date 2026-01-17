# Learning Agent

## Scope
Applies to `src/agents/learning/`.

## Responsibilities
- Generate insights from telemetry and emit `learning:insight` events.
- Keep learning outputs conservative and advisory by default.

## Rules
- Do not mutate trading state directly; emit insights only.
- Ensure outputs are bounded and schema-valid.
- Fail closed when LLM responses are invalid.

## Tests
- `npm run test -- tests/unit/learning-agent.test.ts`
