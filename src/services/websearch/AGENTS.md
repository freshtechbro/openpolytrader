# Web Search Services

## Scope
Applies to `src/services/websearch/`.

## Responsibilities
- Provide web search clients (Exa, Firecrawl) for signal aggregation.
- Implement rate limiting, retry policies, and caching for search APIs.
- Normalize search results into typed `WebSearchContent` format.

## Rules
- Never log API keys or search query parameters containing sensitive data.
- Respect rate limits with token bucket algorithm; fail gracefully on 429s.
- Cache search results to reduce API costs and improve latency.
- Handle authentication failures with cooldown to prevent account lockout.

## Tests
- `npm run test -- tests/unit/websearch.test.ts`
- `npm run test -- tests/unit/websearch_cache.test.ts`
