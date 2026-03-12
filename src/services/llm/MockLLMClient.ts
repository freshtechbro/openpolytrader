import type { LLMCallResult, LLMAgentId, LLMProviderId, LLMRequest, LLMUsage } from './types.js';

interface MockLLMClientOptions {
  defaultProviderId?: LLMProviderId;
  defaultBaseUrl?: string;
  defaultLatencyMs?: number;
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  nowMs?: () => number;
}

interface MockLLMResponse {
  status: LLMCallResult['status'];
  outputText?: string | null;
  endpoint?: LLMCallResult['endpoint'];
  model?: string | null;
  providerId?: LLMProviderId | null;
  baseUrl?: string | null;
  usage?: LLMUsage;
  latencyMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  attempt?: number;
  requestIdHeader?: string;
  requestIdBody?: string;
  responseId?: string;
  error?: LLMCallResult['error'];
  fallbackReason?: string;
}

export class MockLLMClient {
  private queues = new Map<LLMAgentId, MockLLMResponse[]>();
  private defaults = new Map<LLMAgentId, MockLLMResponse>();

  private defaultProviderId: LLMProviderId;
  private defaultBaseUrl: string;
  private defaultLatencyMs: number;
  private defaultTimeoutMs: number;
  private defaultMaxRetries: number;
  private nowMs: () => number;

  constructor(options: MockLLMClientOptions = {}) {
    this.defaultProviderId = options.defaultProviderId ?? 'opencode-zen';
    if (!options.defaultBaseUrl) {
      throw new Error('MockLLMClient requires defaultBaseUrl');
    }
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.defaultLatencyMs = Math.max(options.defaultLatencyMs ?? 0, 0);
    this.defaultTimeoutMs = Math.max(options.defaultTimeoutMs ?? 500, 1);
    this.defaultMaxRetries = Math.max(options.defaultMaxRetries ?? 0, 0);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  enqueue(agent: LLMAgentId, response: MockLLMResponse): void {
    const queue = this.queues.get(agent) ?? [];
    queue.push(response);
    this.queues.set(agent, queue);
  }

  setDefault(agent: LLMAgentId, response: MockLLMResponse): void {
    this.defaults.set(agent, response);
  }

  clear(agent?: LLMAgentId): void {
    if (agent) {
      this.queues.delete(agent);
      this.defaults.delete(agent);
      return;
    }
    this.queues.clear();
    this.defaults.clear();
  }

  async call(agent: LLMAgentId, request: LLMRequest): Promise<LLMCallResult> {
    const startedAtMs = this.nowMs();
    const queued = this.queues.get(agent);
    const next = queued && queued.length > 0 ? queued.shift()! : this.defaults.get(agent);
    if (queued && queued.length === 0) this.queues.delete(agent);

    const response: MockLLMResponse =
      next ??
      ({
        status: 'error',
        error: { type: 'no_mock_response', message: 'no_mock_response' },
        outputText: null
      } satisfies MockLLMResponse);

    const latencyMs = Math.max(response.latencyMs ?? this.defaultLatencyMs, 0);
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    return {
      status: response.status,
      providerId: response.providerId === undefined ? this.defaultProviderId : response.providerId,
      baseUrl: response.baseUrl === undefined ? this.defaultBaseUrl : response.baseUrl,
      endpoint: response.endpoint === undefined ? request.endpoint : response.endpoint,
      model: response.model === undefined ? request.model : response.model,
      outputText: response.outputText ?? null,
      startedAtMs,
      latencyMs,
      timeoutMs: response.timeoutMs ?? this.defaultTimeoutMs,
      maxRetries: response.maxRetries ?? this.defaultMaxRetries,
      attempt: response.attempt ?? 1,
      requestIdHeader: response.requestIdHeader,
      requestIdBody: response.requestIdBody,
      responseId: response.responseId,
      usage: response.usage,
      error: response.error,
      fallbackReason: response.fallbackReason
    };
  }
}
