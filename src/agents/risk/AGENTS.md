# Risk Agent

## Scope
Applies to `src/agents/risk/`.

## Responsibilities
- Evaluate gate inputs and compute position sizing constraints.
- Apply advisory LLM recommendations only within deterministic bounds.

## Rules
- Never allow LLM output to exceed deterministic max/min constraints.
- Keep gate evaluation pure and reproducible.
- Preserve near-zero-risk defaults when no profile is applied.

## Tests
- `npm run test -- tests/unit/risk.test.ts`
- `npm run test -- tests/unit/risk-extended.test.ts`
- `npm run test -- tests/unit/risk-agent-llm.test.ts`
- `npm run test -- tests/unit/risk-advisor.test.ts`
