import type { LLMCallResult, LLMMessagesRequest, LLMUsage } from './types.js';

export interface ZenMessagesClientOptions {
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
        throw new ZenMessagesError(message, response.status);
      }

      const outputText = extractTextFromMessagesResponse(parsed);
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

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ZenMessagesError';
    this.status = status;
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
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const direct = coerceText(record.output_text ?? record.completion ?? record.text);
  if (direct) return direct;

  const parts: string[] = [];
  collectTextParts(record.content, parts);
  collectTextParts(record.message, parts);
  collectTextParts(record.choices, parts);
  collectTextParts(record.output, parts);

  if (parts.length === 0) return null;
  return parts.join('\n').trim();
}

function coerceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectTextParts(input: unknown, parts: string[]): void {
  if (!input) return;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length > 0) parts.push(trimmed);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      collectTextParts(item, parts);
    }
    return;
  }
  if (typeof input !== 'object') return;

  const record = input as Record<string, unknown>;
  const text = record.text;
  if (typeof text === 'string') {
    const trimmed = text.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  } else if (text) {
    collectTextParts(text, parts);
  }

  const content = record.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  } else if (content) {
    collectTextParts(content, parts);
  }

  const value = record.value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }

  const completion = record.completion;
  if (typeof completion === 'string') {
    const trimmed = completion.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }

  const outputText = record.output_text;
  if (typeof outputText === 'string') {
    const trimmed = outputText.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }

  if (record.message) collectTextParts(record.message, parts);
  if (record.choices) collectTextParts(record.choices, parts);
  if (record.output) collectTextParts(record.output, parts);
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
