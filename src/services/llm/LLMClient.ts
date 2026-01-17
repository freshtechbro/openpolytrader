import type { MetricsStore } from '../../telemetry/metrics.js';
import { CircuitBreakerRegistry } from '../../core/CircuitBreaker.js';

import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';

import { OpenAISdkClient, LLMTimeoutError } from './OpenAISdkClient.js';
import { ZenMessagesClient } from './ZenMessagesClient.js';
import { selectProviders } from './LLMRouter.js';
import type {
  LLMCallResult,
  LLMAgentId,
  LLMChatRequest,
  LLMEndpoint,
  LLMMessagesRequest,
  LLMRequest,
  LLMProviderId,
  LLMResponsesRequest
} from './types.js';

export interface LLMClientOptions {
  metrics?: MetricsStore;
}

export class LLMClient {
  private clients = new Map<LLMProviderId, OpenAISdkClient>();
  private zenMessageClients = new Map<LLMProviderId, ZenMessagesClient>();
  private breakers: CircuitBreakerRegistry;

  constructor(
    private config: AppLLMConfig,
    private options: LLMClientOptions = {}
  ) {
    this.breakers = new CircuitBreakerRegistry(
      {
        failureThreshold: config.circuitBreaker.failureThreshold,
        cooldownMs: config.circuitBreaker.cooldownMs,
        halfOpenSuccesses: config.circuitBreaker.halfOpenSuccesses
      },
      'llm'
    );
  }

  async call(agent: LLMAgentId, request: LLMRequest, nowMs = Date.now()): Promise<LLMCallResult> {
    const startedAtMs = nowMs;
    const agentConfig = this.config.agents[agent];
    const agentMode = agentConfig.mode;

    if (!this.config.enabled || agentMode === 'disabled') {
      return {
        status: 'disabled',
        providerId: null,
        baseUrl: null,
        endpoint: null,
        model: null,
        outputText: null,
        startedAtMs,
        latencyMs: 0,
        timeoutMs: agentConfig.timeoutMs,
        maxRetries: this.config.retry.maxRetries,
        attempt: 0
      };
    }

    const timeoutMs = agentConfig.timeoutMs;
    const maxRetries = this.config.retry.maxRetries;
    const selection = selectProviders(this.config, agent);
    const retryCount = Math.max(this.config.primaryRetryCount, 0);
    const primaryAttempts = 1 + retryCount;

    let attempt = 1;
    let lastResult: LLMCallResult | null = null;

    for (let i = 0; i < primaryAttempts; i += 1) {
      const primaryResult = await this.tryProvider({
        providerId: selection.primaryId,
        agent,
        request,
        timeoutMs,
        maxRetries,
        attempt,
        startedAtMs
      });
      attempt += 1;
      if (primaryResult.status === 'success') return primaryResult;
      lastResult = primaryResult;
    }

    const backupModel = agentConfig.backupModel;

    if (backupModel) {
      const primaryFailureReason = buildFallbackReason('primary', lastResult);
      const backupRequest = buildBackupRequest(request, backupModel, agentConfig.backupEndpoint);
      const backupResult = await this.tryProvider({
        providerId: selection.primaryId,
        agent,
        request: backupRequest,
        timeoutMs,
        maxRetries,
        attempt,
        startedAtMs,
        fallbackReason: primaryFailureReason
      });
      attempt += 1;

      if (backupResult.status === 'success') {
        return { ...backupResult, status: 'fallback', fallbackReason: primaryFailureReason };
      }
      lastResult = backupResult;
    }

    if (!this.config.fallbackEnabled) {
      return lastResult ?? {
        status: 'error',
        providerId: selection.primaryId,
        baseUrl: this.config.providers[selection.primaryId].baseUrl,
        endpoint: request.endpoint,
        model: request.model,
        outputText: null,
        startedAtMs,
        latencyMs: Date.now() - startedAtMs,
        timeoutMs,
        maxRetries,
        attempt: attempt - 1,
        fallbackReason: 'fallback_disabled',
        error: { type: 'fallback_disabled', message: 'fallback_disabled' }
      };
    }

    const providerFallbackReason = buildFallbackReason(backupModel ? 'backup' : 'primary', lastResult);
    const providerFallbackResult = await this.tryProvider({
      providerId: selection.fallbackId,
      agent,
      request,
      timeoutMs,
      maxRetries,
      attempt,
      startedAtMs,
      fallbackReason: providerFallbackReason
    });

    if (providerFallbackResult.status === 'success') {
      return { ...providerFallbackResult, status: 'fallback', fallbackReason: providerFallbackReason };
    }

    // Bubble up the fallback failure (fail-open to deterministic in callers).
    return providerFallbackResult;
  }

  private async tryProvider(args: {
    providerId: LLMProviderId;
    agent: LLMAgentId;
    request: LLMRequest;
    timeoutMs: number;
    maxRetries: number;
    attempt: number;
    startedAtMs: number;
    fallbackReason?: string;
  }): Promise<LLMCallResult> {
    const provider = this.config.providers[args.providerId];
    const baseUrl = provider.baseUrl;
    const apiKey = provider.apiKey;
    const request = normalizeRequestForProvider(args.providerId, args.request);

    if (!apiKey) {
      return {
        status: 'error',
        providerId: args.providerId,
        baseUrl,
        endpoint: request.endpoint,
        model: request.model,
        outputText: null,
        startedAtMs: args.startedAtMs,
        latencyMs: Date.now() - args.startedAtMs,
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        attempt: args.attempt,
        fallbackReason: args.fallbackReason,
        error: { type: 'missing_api_key', message: 'missing_api_key' }
      };
    }

    const breakerKey = args.providerId;
    if (this.breakers.isOpen(breakerKey)) {
      return {
        status: 'error',
        providerId: args.providerId,
        baseUrl,
        endpoint: request.endpoint,
        model: request.model,
        outputText: null,
        startedAtMs: args.startedAtMs,
        latencyMs: Date.now() - args.startedAtMs,
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        attempt: args.attempt,
        fallbackReason: args.fallbackReason ?? 'circuit_open',
        error: { type: 'circuit_open', message: `circuit_open:${breakerKey}` }
      };
    }

    const attemptStart = Date.now();

    try {
      const data =
        request.endpoint === 'messages'
          ? await this.breakers.get(breakerKey).execute(() =>
              this.getZenMessagesClient(args.providerId).request(request, {
                timeoutMs: args.timeoutMs,
                maxRetries: args.maxRetries,
                attempt: args.attempt
              })
            )
          : await this.breakers.get(breakerKey).execute(() =>
              this.getClient(args.providerId).request(request, {
                timeoutMs: args.timeoutMs,
                maxRetries: args.maxRetries,
                attempt: args.attempt
              })
            );

      const latencyMs = Date.now() - attemptStart;
      this.options.metrics?.record({
        type: 'llm_latency',
        timestamp: Date.now(),
        data: {
          agent: args.agent,
          providerId: args.providerId,
          endpoint: data.endpoint,
          model: data.model,
          latencyMs
        }
      });

      const outputText = typeof data.outputText === 'string' ? data.outputText.trim() : '';
      if (outputText.length === 0) {
        return {
          status: 'error',
          providerId: args.providerId,
          baseUrl: data.baseUrl,
          endpoint: data.endpoint,
          model: data.model,
          outputText: null,
          startedAtMs: args.startedAtMs,
          latencyMs,
          timeoutMs: data.timeoutMs,
          maxRetries: data.maxRetries,
          attempt: data.attempt,
          requestIdHeader: data.requestIdHeader,
          requestIdBody: data.requestIdBody,
          responseId: data.responseId,
          usage: data.usage,
          fallbackReason: args.fallbackReason,
          error: { type: 'empty_output', message: 'empty_output_text' }
        };
      }

      return {
        status: 'success',
        providerId: args.providerId,
        baseUrl: data.baseUrl,
        endpoint: data.endpoint,
        model: data.model,
        outputText: data.outputText,
        startedAtMs: args.startedAtMs,
        latencyMs,
        timeoutMs: data.timeoutMs,
        maxRetries: data.maxRetries,
        attempt: data.attempt,
        requestIdHeader: data.requestIdHeader,
        requestIdBody: data.requestIdBody,
        responseId: data.responseId,
        usage: data.usage,
        fallbackReason: args.fallbackReason
      };
    } catch (error) {
      const latencyMs = Date.now() - attemptStart;
      const mapped = mapLLMError(error);
      const requestIdHeader = extractErrorRequestIdHeader(error);

      this.options.metrics?.record({
        type: mapped.type === 'timeout' ? 'llm_timeout' : 'llm_error',
        timestamp: Date.now(),
        data: {
          agent: args.agent,
          providerId: args.providerId,
          endpoint: request.endpoint,
          model: request.model,
          latencyMs,
          error: mapped
        }
      });

      return {
        status: mapped.type === 'timeout' ? 'timeout' : 'error',
        providerId: args.providerId,
        baseUrl,
        endpoint: request.endpoint,
        model: request.model,
        outputText: null,
        startedAtMs: args.startedAtMs,
        latencyMs,
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        attempt: args.attempt,
        fallbackReason: args.fallbackReason,
        error: mapped,
        requestIdHeader
      };
    }
  }

  private getClient(providerId: LLMProviderId): OpenAISdkClient {
    const existing = this.clients.get(providerId);
    if (existing) return existing;

    const provider = this.config.providers[providerId];
    const apiKey = provider.apiKey;
    if (!apiKey) {
      throw new Error(`Invalid LLM configuration: missing API key for provider ${providerId}`);
    }

    const created = new OpenAISdkClient({
      apiKey,
      baseURL: provider.baseUrl,
      defaultHeaders: provider.defaultHeaders,
      timeoutMs: this.config.retry.timeoutMs,
      maxRetries: this.config.retry.maxRetries
    });
    this.clients.set(providerId, created);
    return created;
  }

  private getZenMessagesClient(providerId: LLMProviderId): ZenMessagesClient {
    const existing = this.zenMessageClients.get(providerId);
    if (existing) return existing;

    if (providerId !== 'opencode-zen') {
      throw new Error(`Invalid LLM configuration: messages endpoint not supported for provider ${providerId}`);
    }

    const provider = this.config.providers[providerId];
    const apiKey = provider.apiKey;
    if (!apiKey) {
      throw new Error(`Invalid LLM configuration: missing API key for provider ${providerId}`);
    }

    const created = new ZenMessagesClient({ apiKey, baseURL: provider.baseUrl });
    this.zenMessageClients.set(providerId, created);
    return created;
  }
}

function normalizeRequestForProvider(providerId: LLMProviderId, request: LLMRequest): LLMRequest {
  if (providerId === 'opencode-zen') {
    const mappedModel = mapOpenRouterModelIdToZen(request.model);

    if (isGPT5FamilyModel(mappedModel)) {
      if (request.endpoint === 'responses') {
        return request.model === mappedModel ? request : { ...request, model: mappedModel };
      }
      if (request.endpoint === 'messages') {
        return messagesToResponsesRequest(request, mappedModel);
      }
      return chatToResponsesRequest(request, mappedModel);
    }

    if (wantsZenMessagesEndpoint(mappedModel)) {
      if (request.endpoint === 'messages') {
        return request.model === mappedModel ? request : { ...request, model: mappedModel };
      }
      if (request.endpoint === 'responses') {
        return responsesToZenMessagesRequest(request, mappedModel);
      }
      return chatToZenMessagesRequest(request, mappedModel);
    }

    return request.model === mappedModel ? request : { ...request, model: mappedModel };
  }

  // Keep OpenRouter normalization unchanged; it must remain OpenAI-compatible.
  if (providerId !== 'openrouter') return request;

  const mappedModel = mapZenModelIdToOpenRouter(request.model);

  // OpenRouter is OpenAI-compatible. Normalize unsupported endpoints into chat.completions.
  // This keeps fallback usable for agent requests that originate in other schemas.
  if (request.endpoint === 'messages') {
    return messagesToChatRequest({ ...request, model: mappedModel }, mappedModel);
  }

  if (request.endpoint !== 'responses') {
    if (request.endpoint !== 'chat.completions') return request;
    return request.model === mappedModel ? request : { ...request, model: mappedModel };
  }

  return responsesToChatRequest({ ...request, model: mappedModel }, mappedModel);
}

function buildFallbackReason(stage: 'primary' | 'backup', lastResult: LLMCallResult | null): string {
  const suffix = lastResult?.status === 'timeout' ? 'timeout' : 'error';
  return `${stage}_${suffix}`;
}

function buildBackupRequest(
  request: LLMRequest,
  backupModel: string,
  backupEndpoint?: LLMEndpoint
): LLMRequest {
  const model = backupModel.trim();
  const requestWithModel = request.model === model ? request : { ...request, model };
  const targetEndpoint = backupEndpoint ?? inferEndpointForModel(model);
  return convertRequestEndpoint(requestWithModel, targetEndpoint);
}

function inferEndpointForModel(model: string): LLMEndpoint {
  if (isGPT5FamilyModel(model)) return 'responses';
  if (wantsZenMessagesEndpoint(model)) return 'messages';
  return 'chat.completions';
}

function convertRequestEndpoint(request: LLMRequest, endpoint: LLMEndpoint): LLMRequest {
  if (request.endpoint === endpoint) return request;

  if (endpoint === 'chat.completions') {
    if (request.endpoint === 'messages') return messagesToChatRequest(request, request.model);
    if (request.endpoint === 'responses') return responsesToChatRequest(request, request.model);
    return request;
  }

  if (endpoint === 'messages') {
    if (request.endpoint === 'chat.completions') return chatToZenMessagesRequest(request, request.model);
    if (request.endpoint === 'responses') return responsesToZenMessagesRequest(request, request.model);
    return request;
  }

  if (request.endpoint === 'chat.completions') return chatToResponsesRequest(request, request.model);
  if (request.endpoint === 'messages') return messagesToResponsesRequest(request, request.model);
  return request;
}

const OPENROUTER_TO_ZEN_MODEL_ID: Record<string, string> = {
  'x-ai/grok-code-fast-1': 'grok-code',
  'z-ai/glm-4.7': 'glm-4.7-free',
  'openai/gpt-5-nano': 'gpt-5-nano',
  'minimax/minimax-m2.1': 'minimax-m2.1-free',
  'qwen/qwen3-coder': 'qwen3-coder'
};

function mapOpenRouterModelIdToZen(model: string): string {
  if (!model.includes('/')) return model;

  const mapped = OPENROUTER_TO_ZEN_MODEL_ID[model];
  if (mapped) return mapped;

  const lastSlash = model.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < model.length - 1) {
    return model.slice(lastSlash + 1);
  }

  return model;
}

function isGPT5FamilyModel(model: string): boolean {
  return model === 'gpt-5' || model.startsWith('gpt-5-');
}

function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-');
}

function wantsZenMessagesEndpoint(model: string): boolean {
  return isClaudeModel(model) || model.startsWith('minimax-');
}

function extractChatSystem(messages: LLMChatRequest['messages']): string | undefined {
  const fragments: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'developer' || msg.role === 'system') {
      const content = msg.content.trim();
      if (content.length > 0) fragments.push(content);
    }
  }

  if (fragments.length === 0) return undefined;
  return fragments.join('\n\n');
}

function isUserOrAssistantMessage(
  message: LLMChatRequest['messages'][number]
): message is { role: 'user' | 'assistant'; content: string } {
  return message.role === 'user' || message.role === 'assistant';
}

function extractChatUserAssistantMessages(
  messages: LLMChatRequest['messages']
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.filter(isUserOrAssistantMessage).map((msg) => ({ role: msg.role, content: msg.content }));
}

function lastUserContent(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function messagesToChatRequest(req: LLMMessagesRequest, model: string): LLMChatRequest {
  const system = typeof req.system === 'string' ? req.system.trim() : '';
  const messages: Array<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }> = [];
  if (system.length > 0) messages.push({ role: 'developer', content: system });
  for (const msg of req.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return {
    endpoint: 'chat.completions',
    model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens
  };
}

function responsesToChatRequest(req: LLMResponsesRequest, model: string): LLMChatRequest {
  const instructions = typeof req.instructions === 'string' ? req.instructions.trim() : '';
  const messages: Array<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }> = [];
  if (instructions.length > 0) {
    messages.push({ role: 'developer', content: instructions });
  }
  messages.push({ role: 'user', content: req.input });

  return {
    endpoint: 'chat.completions',
    model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_output_tokens
  };
}

function chatToZenMessagesRequest(req: LLMChatRequest, model: string): LLMMessagesRequest {
  const system = extractChatSystem(req.messages);
  const messages = extractChatUserAssistantMessages(req.messages);
  const maxTokens = typeof req.max_tokens === 'number' ? req.max_tokens : 200;

  return {
    endpoint: 'messages',
    model,
    system,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: maxTokens
  };
}

function chatToResponsesRequest(req: LLMChatRequest, model: string): LLMResponsesRequest {
  const instructions = extractChatSystem(req.messages);
  const input = lastUserContent(req.messages);

  return {
    endpoint: 'responses',
    model,
    instructions,
    input,
    temperature: req.temperature,
    top_p: req.top_p,
    max_output_tokens: req.max_tokens
  };
}

function responsesToZenMessagesRequest(req: LLMResponsesRequest, model: string): LLMMessagesRequest {
  const system = typeof req.instructions === 'string' ? req.instructions.trim() : '';
  const maxTokens = typeof req.max_output_tokens === 'number' ? req.max_output_tokens : 200;

  return {
    endpoint: 'messages',
    model,
    system: system.length > 0 ? system : undefined,
    messages: [{ role: 'user', content: req.input }],
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: maxTokens
  };
}

function messagesToResponsesRequest(req: LLMMessagesRequest, model: string): LLMResponsesRequest {
  const instructions = typeof req.system === 'string' ? req.system.trim() : '';
  const input = lastUserContent(req.messages);

  return {
    endpoint: 'responses',
    model,
    instructions: instructions.length > 0 ? instructions : undefined,
    input,
    temperature: req.temperature,
    top_p: req.top_p,
    max_output_tokens: req.max_tokens
  };
}

function mapZenModelIdToOpenRouter(model: string): string {
  // If the caller already provided an OpenRouter-style model id, keep it unchanged.
  if (model.includes('/')) return model;

  switch (model) {
    case 'grok-code':
      return 'x-ai/grok-code-fast-1';
    case 'glm-4.7-free':
      return 'z-ai/glm-4.7';
    case 'gpt-5-nano':
      return 'openai/gpt-5-nano';
    case 'minimax-m2.1-free':
      return 'minimax/minimax-m2.1';
    case 'qwen3-coder':
      return 'qwen/qwen3-coder';
    default:
      return model;
  }
}

function mapLLMError(error: unknown): { type: string; status?: number; message: string } {
  if (error instanceof LLMTimeoutError) {
    return { type: 'timeout', message: error.message };
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string' &&
    (error as { name: string }).name === 'AbortError'
  ) {
    const message = typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'timeout';
    return { type: 'timeout', message };
  }
  if (error && typeof error === 'object') {
    const message = typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'unknown_error';
    const status = typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;
    return { type: 'error', status, message };
  }
  return { type: 'error', message: String(error) };
}

function extractErrorRequestIdHeader(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate =
    (error as { requestIdHeader?: unknown }).requestIdHeader ??
    (error as { request_id?: unknown }).request_id ??
    (error as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' ? candidate : undefined;
}
