import { extractResponseText } from './extractResponseText.js';
import type { LLMCallResult, LLMMessagesRequest, LLMUsage } from './types.js';

interface ZenMessagesClientOptions {
  apiKey: string;
  baseURL: string;
}

export class ZenMessagesClient {
  private baseURL: string;
  private apiKey: string;

  constructor(options: ZenMessagesClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  async request(
    request: LLMMessagesRequest,
    opts: { timeoutMs: number; maxRetries: number; attempt: number }
  ): Promise<Omit<LLMCallResult, 'status' | 'providerId' | 'startedAtMs' | 'latencyMs'>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(opts.timeoutMs, 1));

    try {
      const url = `${this.baseURL}/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({
          model: request.model,
          system: request.system,
          messages: request.messages,
          temperature: request.temperature,
          top_p: request.top_p,
          max_tokens: request.max_tokens
        }),
        signal: controller.signal
      });

      const text = await response.text();
      const parsed = safeParseJson(text);

      if (!response.ok) {
        const message =
          parsed &&
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).error === 'object' &&
          (parsed as Record<string, unknown>).error !== null &&
          typeof ((parsed as Record<string, unknown>).error as Record<string, unknown>).message === 'string'
            ? String(((parsed as Record<string, unknown>).error as Record<string, unknown>).message)
            : `http_${response.status}`;
        throw new ZenMessagesError(message, response.status, 'http_error');
      }

      if (parsed === null) {
        throw new ZenMessagesError('invalid_json', response.status, 'malformed_response');
      }

      const outputText = extractTextFromMessagesResponse(parsed);
      if (outputText === null) {
        throw new ZenMessagesError('empty_output_text', response.status, 'malformed_response');
      }
      const responseId =
        parsed && typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).id === 'string'
          ? String((parsed as Record<string, unknown>).id)
          : undefined;

      return {
        baseUrl: this.baseURL,
        endpoint: 'messages',
        model: request.model,
        outputText,
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        attempt: opts.attempt,
        requestIdHeader: undefined,
        requestIdBody: undefined,
        responseId,
        usage: mapMessagesUsage(parsed)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ZenMessagesError extends Error {
  status?: number;
  type: string;

  constructor(message: string, status?: number, type = 'error') {
    super(message);
    this.name = 'ZenMessagesError';
    this.status = status;
    this.type = type;
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTextFromMessagesResponse(value: unknown): string | null {
  return extractResponseText(value);
}

function mapMessagesUsage(value: unknown): LLMUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const anyUsage = usage as { input_tokens?: number; output_tokens?: number };
  const inputTokens = typeof anyUsage.input_tokens === 'number' ? anyUsage.input_tokens : undefined;
  const outputTokens = typeof anyUsage.output_tokens === 'number' ? anyUsage.output_tokens : undefined;
  const totalTokens =
    typeof inputTokens === 'number' && typeof outputTokens === 'number' ? inputTokens + outputTokens : undefined;
  return { inputTokens, outputTokens, totalTokens };
}
