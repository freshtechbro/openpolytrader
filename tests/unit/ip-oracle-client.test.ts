import { describe, expect, it, vi } from 'vitest';

import {
  IpOracleClient,
  type IpOracleRequest
} from '../../src/services/ip-oracle/IpOracleClient.js';

const BASE_REQUEST: IpOracleRequest = {
  requestId: 'req-1',
  timeLimitMs: 50,
  objective: {
    variables: ['x1'],
    coefficients: [1],
    sense: 'min'
  },
  constraints: {
    type: 'linear_binary',
    rows: [{ coefficients: [1], op: '<=', rhs: 1 }]
  }
};

describe('IpOracleClient', () => {
  it('supports runtime config updates', async () => {
    const client = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fallbackSolver: async () => ({
        requestId: 'initial',
        status: 'feasible',
        runtimeMs: 1
      })
    });

    client.updateConfig({
      timeoutMs: 100,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fallbackSolver: async () => ({
        requestId: 'updated',
        status: 'optimal',
        runtimeMs: 1
      })
    });

    const result = await client.solve({ ...BASE_REQUEST, requestId: 'req-updated' }, 100);
    expect(result.status).toBe('optimal');
  });

  it('uses fallback solver and returns normalized response', async () => {
    const client = new IpOracleClient({
      timeoutMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 1_000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'feasible',
        objectiveValue: -0.1,
        assignment: { x1: 1 },
        runtimeMs: 5
      })
    });

    const response = await client.solve(BASE_REQUEST, 100);
    expect(response.status).toBe('feasible');
    expect(response.assignment).toEqual({ x1: 1 });
    expect(response.error).toBeNull();
  });

  it('normalizes oracle responses with missing status/runtime fields', async () => {
    const client = new IpOracleClient({
      timeoutMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 1_000,
      fallbackSolver: async () =>
        ({
          requestId: 'raw',
          status: undefined,
          runtimeMs: Number.NaN
        }) as unknown as {
          requestId: string;
          status: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
          runtimeMs: number;
        }
    });

    const response = await client.solve({ ...BASE_REQUEST, requestId: 'req-normalize' }, 100);
    expect(response.status).toBe('unknown');
    expect(response.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it('maps fallback timeout failures and opens circuit after threshold', async () => {
    vi.useFakeTimers();
    const client = new IpOracleClient({
      timeoutMs: 10,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fallbackSolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          requestId: 'late',
          status: 'feasible',
          runtimeMs: 100
        };
      }
    });

    const p1 = client.solve(BASE_REQUEST, 10);
    await vi.advanceTimersByTimeAsync(20);
    const first = await p1;
    expect(first.status).toBe('timeout');

    const p2 = client.solve({ ...BASE_REQUEST, requestId: 'req-2' }, 20);
    await vi.advanceTimersByTimeAsync(20);
    const second = await p2;
    expect(second.status).toBe('timeout');

    const blocked = await client.solve({ ...BASE_REQUEST, requestId: 'req-3' }, 21);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toBe('circuit_open');

    const recovered = client.solve({ ...BASE_REQUEST, requestId: 'req-4' }, 200);
    await vi.advanceTimersByTimeAsync(20);
    const recoveredResult = await recovered;
    expect(recoveredResult.status).toBe('timeout');

    vi.useRealTimers();
  });

  it('calls HTTP oracle when fallback is not configured', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requestId: 'req-1',
        status: 'optimal',
        objectiveValue: -0.2,
        assignment: { x1: 1 },
        runtimeMs: 4
      })
    }));

    const client = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 100,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const response = await client.solve(BASE_REQUEST, 100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe('optimal');
    expect(response.objectiveValue).toBeCloseTo(-0.2, 6);
  });

  it('adds auth header when FW oracle API key is configured', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requestId: 'req-1',
        status: 'optimal',
        runtimeMs: 4
      })
    }));

    const client = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 100,
      apiKey: 'token-1',
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await client.solve(BASE_REQUEST, 100);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[1]?.headers).toMatchObject({
      authorization: 'Bearer token-1'
    });
  });

  it('returns error status when HTTP oracle is unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket_closed');
    });

    const client = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 100,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const response = await client.solve(BASE_REQUEST, 100);
    expect(response.status).toBe('error');
    expect(response.error).toContain('socket_closed');
  });

  it('handles non-Error failures from HTTP calls', async () => {
    const fetchImpl = vi.fn(async () => {
      throw 'transport_down';
    });

    const client = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 100,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const response = await client.solve(BASE_REQUEST, 100);
    expect(response.status).toBe('error');
    expect(response.error).toContain('transport_down');
  });

  it('maps non-timeout Error failures to error status', async () => {
    const client = new IpOracleClient({
      timeoutMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fallbackSolver: async () => {
        throw new Error('boom');
      }
    });

    const response = await client.solve({ ...BASE_REQUEST, requestId: 'req-boom' }, 100);
    expect(response.status).toBe('error');
    expect(response.error).toContain('boom');
  });

  it('returns timeout status for aborted HTTP calls and non-200 responses', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const timeoutFetch = vi.fn(async () => {
      throw abortError;
    });
    const timeoutClient = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 1,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: timeoutFetch as unknown as typeof fetch
    });
    const timeoutResult = await timeoutClient.solve(BASE_REQUEST, 100);
    expect(timeoutResult.status).toBe('timeout');

    const notOkFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }));
    const nonOkClient = new IpOracleClient({
      baseUrl: 'http://localhost:7071',
      timeoutMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fetchImpl: notOkFetch as unknown as typeof fetch
    });
    const nonOkResult = await nonOkClient.solve(BASE_REQUEST, 100);
    expect(nonOkResult.status).toBe('error');
    expect(nonOkResult.error).toContain('oracle_http_500');
  });

  it('returns error when oracle base URL is missing and no fallback is configured', async () => {
    const client = new IpOracleClient({
      timeoutMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100
    });

    const result = await client.solve(BASE_REQUEST, 100);
    expect(result.status).toBe('error');
    expect(result.error).toContain('oracle_unconfigured');
  });

  it('skips timeout race when timeoutMs is zero or negative', async () => {
    const client = new IpOracleClient({
      timeoutMs: 0,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      fallbackSolver: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          requestId: request.requestId,
          status: 'feasible',
          runtimeMs: 15
        };
      }
    });

    const result = await client.solve({ ...BASE_REQUEST, requestId: 'req-no-timeout-race' }, 100);
    expect(result.status).toBe('feasible');
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
  });
});
