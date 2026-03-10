import type { MetricsStore } from '../../telemetry/metrics.js';
import { safeParseJsonBody } from '../../utils/serialization.js';
import { RateLimiter } from '../RateLimiter.js';
import { RetryPolicy } from '../RetryPolicy.js';
import { WebSearchCache } from './WebSearchCache.js';
import { recordWebSearchMetric } from './WebSearchProviderMetrics.js';

type WebSearchRequestKind = 'search' | 'contents' | 'scrape' | 'crawl';

interface WebSearchRequestOptions<TError extends Error> {
  provider: string;
  providerLabel?: string;
  baseUrl: string;
  timeoutMs: number;
  limiter: RateLimiter;
  retryPolicy: RetryPolicy;
  metrics?: MetricsStore;
  headers: Record<string, string>;
  createError: (message: string, status: number, body: unknown) => TError;
  onHttpError?: (kind: WebSearchRequestKind, status: number, nowMs: number) => void;
  onSuccess?: (kind: WebSearchRequestKind, nowMs: number, latencyMs: number) => void;
}

interface WebSearchClientRuntimeConfig {
  baseUrl?: string;
  timeoutMs: number;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxContentBytes: number;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

interface WebSearchClientRuntime {
  baseUrl: string;
  timeoutMs: number;
  limiter: RateLimiter;
  retryPolicy: RetryPolicy;
  maxContentBytes: number;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export function createWebSearchClientRuntime(
  config: WebSearchClientRuntimeConfig,
  options: {
    resolveBaseUrl: (baseUrl?: string) => string;
    shouldRetry: (error: unknown) => boolean;
  }
): WebSearchClientRuntime {
  return {
    baseUrl: options.resolveBaseUrl(config.baseUrl),
    timeoutMs: config.timeoutMs,
    limiter: new RateLimiter(config.rateLimitPerWindow, config.rateLimitWindowMs),
    retryPolicy: new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: options.shouldRetry
    }),
    maxContentBytes: Math.max(config.maxContentBytes, 1),
    cache: config.cache,
    metrics: config.metrics
  };
}

export async function requestWebSearchJson<TError extends Error>(
  options: WebSearchRequestOptions<TError>,
  method: string,
  path: string,
  body: Record<string, unknown>,
  kind: WebSearchRequestKind
): Promise<unknown> {
  await options.limiter.acquire();

  return options.retryPolicy.execute(async () => {
    const url = new URL(path, options.baseUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAtMs = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: options.headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      const parsedResult = safeParseJsonBody(text);

      if (!response.ok) {
        const failedAtMs = Date.now();
        recordWebSearchMetric(options.metrics, 'request_failed', {
          provider: options.provider,
          kind,
          status: response.status
        });
        options.onHttpError?.(kind, response.status, failedAtMs);
        throw options.createError(
          `${options.providerLabel ?? options.provider} API error ${response.status} for ${method} ${path}`,
          response.status,
          parsedResult.failed ? { raw: text } : parsedResult.parsed
        );
      }

      if (parsedResult.failed) {
        const snippet = text.slice(0, 200);
        throw new Error(
          `${options.providerLabel ?? options.provider} API invalid JSON for ${method} ${path}: ${snippet}`
        );
      }

      const finishedAtMs = Date.now();
      const latencyMs = finishedAtMs - startedAtMs;
      options.onSuccess?.(kind, finishedAtMs, latencyMs);
      recordWebSearchMetric(options.metrics, 'request_ok', {
        provider: options.provider,
        kind,
        latencyMs
      });
      return parsedResult.parsed;
    } finally {
      clearTimeout(timeout);
    }
  });
}
