# LLM Services

## Scope
Applies to `src/services/llm/`.

## Responsibilities
- LLM client routing, retries, and decision logging.
- Normalize provider config and enforce advisory defaults.

## Rules
- Do not send requests without configured API keys.
- Preserve audit logging for prompts and outputs.
- Keep provider fallbacks deterministic and bounded.

## Tests
- `npm run test -- tests/unit/llm-config.test.ts`
- `npm run test -- tests/unit/llm-services.test.ts`
- `npm run test -- tests/unit/llm-decision-logger.test.ts`
- `npm run test -- tests/unit/zen-messages-client.test.ts`
- `npm run test -- tests/integration/llm-shadow.test.ts`
