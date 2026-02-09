# Signal Aggregator Agent

## Scope
Applies to `src/agents/signal/`.

## Responsibilities
- Aggregate trading signals from multiple sources (market data, web search, LLM insights).
- Score opportunities using policy-driven weights and external data.
- Emit `learning:insight` events with confidence scores and metadata for downstream scoring.

## Rules
- Respect domain allowlist/denylist for web search sources.
- Cache insights and market metadata with TTL to avoid redundant API calls.
- Keep signal scoring deterministic unless explicitly in LLM advisory mode.
- Handle web search client failures gracefully; fail open for advisory signals.

## Tests
- `npm run test -- tests/unit/signal-aggregator.test.ts`
- `npm run test -- tests/unit/websearch.test.ts`
- `npm run test -- tests/unit/llm-services.test.ts`
