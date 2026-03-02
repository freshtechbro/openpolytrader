import { setTimeout as delay } from 'node:timers/promises';

export type IpOracleStatus =
  | 'optimal'
  | 'feasible'
  | 'infeasible'
  | 'timeout'
  | 'error'
  | 'unknown';

export interface IpOracleRequest {
  requestId: string;
  loopId?: string;
  iteration?: number;
  timeLimitMs: number;
  seed?: number;
  objective: {
    variables: string[];
    coefficients: number[];
    sense: 'min' | 'max';
  };
  constraints: {
    type: 'linear_binary';
    rows: Array<{
      coefficients: number[];
      op: '<=' | '>=' | '=';
      rhs: number;
    }>;
  };
  warmStartHint?: {
    variables: string[];
    values: number[];
  };
}

export interface IpOracleResponse {
  requestId: string;
  loopId?: string;
  iteration?: number;
  status: IpOracleStatus;
  objectiveValue?: number;
  bestBound?: number;
  assignment?: Record<string, number>;
  gap?: number;
  relativeGap?: number;
  runtimeMs: number;
  diagnostics?: {
    conflicts?: number;
    branches?: number;
    restarts?: number;
  };
  error?: string | null;
}

export interface IpOracleClientConfig {
  baseUrl?: string;
  timeoutMs: number;
  apiKey?: string;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  fetchImpl?: typeof fetch;
  fallbackSolver?: (request: IpOracleRequest) => Promise<IpOracleResponse>;
}

interface OracleCircuitState {
  failures: number;
  openedAtMs: number | null;
}

export class IpOracleClient {
  private circuit: OracleCircuitState = { failures: 0, openedAtMs: null };
  private readonly fetchImpl: typeof fetch;

  constructor(private config: IpOracleClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  updateConfig(config: IpOracleClientConfig): void {
    this.config = config;
  }

  async solve(request: IpOracleRequest, nowMs = Date.now()): Promise<IpOracleResponse> {
    if (this.isCircuitOpen(nowMs)) {
      return {
        requestId: request.requestId,
        status: 'error',
        runtimeMs: 0,
        error: 'circuit_open'
      };
    }

    const startedAt = Date.now();
    try {
      const response = this.config.fallbackSolver
        ? await this.solveWithFallback(request, this.config.timeoutMs)
        : await this.solveWithHttp(request, this.config.timeoutMs);
      this.resetCircuit();
      return normalizeResponse(response, request.requestId, Date.now() - startedAt);
    } catch (error) {
      this.recordFailure(nowMs);
      return {
        requestId: request.requestId,
        status: classifyOracleError(error),
        runtimeMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async solveWithFallback(request: IpOracleRequest, timeoutMs: number): Promise<IpOracleResponse> {
    const solver = this.config.fallbackSolver as (request: IpOracleRequest) => Promise<IpOracleResponse>;
    return withTimeout(solver(request), timeoutMs, 'timeout');
  }

  private async solveWithHttp(request: IpOracleRequest, timeoutMs: number): Promise<IpOracleResponse> {
    const baseUrl = this.config.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error('oracle_unconfigured');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      timeoutHandle.unref?.();

      try {
        const response = await this.fetchImpl(`${baseUrl}/solve`, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: controller.signal
        });
        if (!response.ok) {
          const detail = await safeResponseSnippet(response);
          if (attempt < maxAttempts && response.status >= 500) {
            await delay(40 * attempt);
            continue;
          }
          throw new Error(detail ? `oracle_http_${response.status}:${detail}` : `oracle_http_${response.status}`);
        }
        return (await response.json()) as IpOracleResponse;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt < maxAttempts) {
            await delay(40 * attempt);
            continue;
          }
          throw new Error('oracle_timeout');
        }
        if (attempt < maxAttempts && isRetryableTransportError(error)) {
          await delay(40 * attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
    throw new Error('oracle_request_failed');
  }

  private isCircuitOpen(nowMs: number): boolean {
    const openedAtMs = this.circuit.openedAtMs;
    if (openedAtMs === null) return false;
    if (nowMs - openedAtMs >= this.config.circuitCooldownMs) {
      this.circuit.openedAtMs = null;
      this.circuit.failures = 0;
      return false;
    }
    return true;
  }

  private recordFailure(nowMs: number): void {
    this.circuit.failures += 1;
    if (this.circuit.failures >= this.config.circuitFailureThreshold) {
      this.circuit.openedAtMs = nowMs;
    }
  }

  private resetCircuit(): void {
    this.circuit.failures = 0;
    this.circuit.openedAtMs = null;
  }
}

async function safeResponseSnippet(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    const compact = raw.replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.slice(0, 256);
  } catch {
    return '';
  }
}

function normalizeResponse(
  input: IpOracleResponse,
  requestId: string,
  runtimeMs: number
): IpOracleResponse {
  return {
    requestId,
    loopId: input.loopId,
    iteration: Number.isFinite(input.iteration) ? input.iteration : undefined,
    status: input.status ?? 'unknown',
    objectiveValue: input.objectiveValue,
    bestBound: input.bestBound,
    assignment: input.assignment,
    gap: input.gap,
    relativeGap: input.relativeGap ?? input.gap,
    runtimeMs: Number.isFinite(input.runtimeMs) ? input.runtimeMs : runtimeMs,
    diagnostics: input.diagnostics,
    error: input.error ?? null
  };
}

function classifyOracleError(error: unknown): IpOracleStatus {
  if (!(error instanceof Error)) return 'error';
  if (error.message.includes('timeout')) return 'timeout';
  return 'error';
}

function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econn') ||
    message.includes('socket') ||
    message.includes('connection')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  const timeoutPromise = delay(timeoutMs).then(() => {
    throw new Error(errorMessage);
  });
  return Promise.race([promise, timeoutPromise]);
}
