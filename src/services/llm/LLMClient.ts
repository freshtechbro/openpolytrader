import type { MetricsStore } from '../../telemetry/metrics.js';
import { CircuitBreakerRegistry } from '../../core/CircuitBreaker.js';

import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';

import { OpenAISdkClient } from './OpenAISdkClient.js';
import { extractErrorRequestIdHeader, mapLLMError } from './LLMErrorMapping.js';
import { buildBackupRequest, normalizeOptionalModelId, normalizeRequestForProvider } from './LLMRequestNormalization.js';
import { ZenMessagesClient } from './ZenMessagesClient.js';
import { selectProviders } from './LLMRouter.js';
import type {
  LLMCallResult,
  LLMAgentId,
  LLMRequest,
  LLMProviderId
} from './types.js';

interface LLMClientOptions {
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

    const fallbackProviderModel = normalizeOptionalModelId(agentConfig.fallbackProviderModel);
    const providerFallbackRequest = fallbackProviderModel
      ? buildBackupRequest(request, fallbackProviderModel)
      : request;
    const providerFallbackReason = buildFallbackReason(backupModel ? 'backup' : 'primary', lastResult);
    const providerFallbackResult = await this.tryProvider({
      providerId: selection.fallbackId,
      agent,
      request: providerFallbackRequest,
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

function buildFallbackReason(stage: 'primary' | 'backup', lastResult: LLMCallResult | null): string {
  const suffix = lastResult?.status === 'timeout' ? 'timeout' : 'error';
  return `${stage}_${suffix}`;
}
