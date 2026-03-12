import { afterEach, describe, expect, it, vi } from 'vitest';

describe('small service and cli helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    Reflect.deleteProperty(globalThis as Record<string, unknown>, 'fetch');
  });

  it('resolves canonical base urls and respects trimmed overrides', async () => {
    const { resolvePolymarketClobBaseUrl, resolvePolymarketDataApiBaseUrl } = await import(
      '../../src/services/PolymarketUrls.js'
    );
    const { resolveExaBaseUrl, resolveFirecrawlBaseUrl } = await import(
      '../../src/services/websearch/WebSearchUrls.js'
    );

    expect(resolvePolymarketClobBaseUrl()).toBe('https://clob.polymarket.com');
    expect(resolvePolymarketClobBaseUrl('  https://override.clob  ')).toBe(
      'https://override.clob'
    );
    expect(resolvePolymarketDataApiBaseUrl()).toBe('https://data-api.polymarket.com');
    expect(resolvePolymarketDataApiBaseUrl('   ')).toBe('https://data-api.polymarket.com');
    expect(resolveExaBaseUrl()).toBe('https://api.exa.ai');
    expect(resolveExaBaseUrl('\nhttps://exa.local\n')).toBe('https://exa.local');
    expect(resolveFirecrawlBaseUrl()).toBe('https://api.firecrawl.dev');
    expect(resolveFirecrawlBaseUrl('\thttps://firecrawl.local\t')).toBe(
      'https://firecrawl.local'
    );
  });

  it('maps llm timeout, abort, and generic errors and extracts request ids', async () => {
    const { LLMTimeoutError } = await import('../../src/services/llm/OpenAISdkClient.js');
    const { extractErrorRequestIdHeader, mapLLMError } = await import(
      '../../src/services/llm/LLMErrorMapping.js'
    );

    expect(mapLLMError(new LLMTimeoutError('provider timeout'))).toEqual({
      type: 'timeout',
      message: 'provider timeout'
    });
    expect(mapLLMError({ name: 'AbortError', message: 'request aborted' })).toEqual({
      type: 'timeout',
      message: 'request aborted'
    });
    expect(mapLLMError({ type: 'rate_limit', status: 429, message: 'Slow down' })).toEqual({
      type: 'rate_limit',
      status: 429,
      message: 'Slow down'
    });
    expect(mapLLMError('plain failure')).toEqual({
      type: 'error',
      message: 'plain failure'
    });
    expect(extractErrorRequestIdHeader({ requestIdHeader: 'req-header' })).toBe('req-header');
    expect(extractErrorRequestIdHeader({ request_id: 'req-body' })).toBe('req-body');
    expect(extractErrorRequestIdHeader({ requestId: 'req-id' })).toBe('req-id');
    expect(extractErrorRequestIdHeader({ requestId: 42 })).toBeUndefined();
  });

  it('executes data api requests and preserves structured error bodies', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const { executeDataApiRequest } = await import('../../src/services/PolymarketDataApiRequest.js');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"positions":[{"asset":"YES"}]}'
    });
    await expect(
      executeDataApiRequest<{ positions: Array<{ asset: string }> }>({
        baseUrl: 'https://data-api.polymarket.com',
        method: 'GET',
        path: '/positions',
        timeoutMs: 1000
      })
    ).resolves.toEqual({ positions: [{ asset: 'YES' }] });
    expect(fetchMock).toHaveBeenCalledWith('https://data-api.polymarket.com/positions', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'openpolytrader/0.1.0'
      },
      signal: expect.any(AbortSignal)
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '{"error":"rate limit"}'
    });
    await expect(
      executeDataApiRequest({
        baseUrl: 'https://data-api.polymarket.com',
        method: 'POST',
        path: '/orders',
        timeoutMs: 1000
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'DataApiError',
        status: 429,
        body: { error: 'rate limit' }
      })
    );

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '<html>down</html>'
    });
    await expect(
      executeDataApiRequest({
        baseUrl: 'https://data-api.polymarket.com',
        method: 'GET',
        path: '/health',
        timeoutMs: 1000
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'DataApiError',
        status: 500,
        body: { raw: '<html>down</html>' }
      })
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    });
    await expect(
      executeDataApiRequest({
        baseUrl: 'https://data-api.polymarket.com',
        method: 'GET',
        path: '/positions',
        timeoutMs: 1000
      })
    ).rejects.toThrow('Polymarket Data API invalid JSON for GET /positions: not-json');
  });

});
