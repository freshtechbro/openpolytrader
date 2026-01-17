import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';

import type { LLMCallResult, LLMRequest, LLMUsage } from './types.js';

export interface OpenAISdkClientOptions {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
}

export class OpenAISdkClient {
  private client: OpenAI;
  private baseURL: string;

  constructor(private options: OpenAISdkClientOptions) {
    this.baseURL = options.baseURL;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries
    });
  }

  async request(
    request: LLMRequest,
    opts: { timeoutMs: number; maxRetries: number; attempt: number }
  ): Promise<Omit<LLMCallResult, 'status' | 'providerId' | 'startedAtMs' | 'latencyMs'>> {
    try {
      if (request.endpoint === 'messages') {
        throw new Error('OpenAISdkClient does not support messages endpoint');
      }
      if (request.endpoint === 'chat.completions') {
        const completion = await this.client.chat.completions.create(
          {
            model: request.model,
            messages: request.messages,
            temperature: request.temperature,
            top_p: request.top_p,
            max_tokens: request.max_tokens
          },
          { timeout: opts.timeoutMs, maxRetries: opts.maxRetries }
        );

        const outputText = extractTextFromOpenAIResponse(completion);
        const requestIdHeader = (completion as unknown as { _request_id?: string })._request_id;
        const requestIdBody =
          (completion as unknown as { request_id?: string }).request_id ??
          (completion as unknown as { requestId?: string }).requestId;

        return {
          baseUrl: this.baseURL,
          endpoint: 'chat.completions',
          model: request.model,
          outputText: typeof outputText === 'string' ? outputText : null,
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          attempt: opts.attempt,
          requestIdHeader,
          requestIdBody,
          responseId: (completion as unknown as { id?: string }).id,
        usage: mapChatUsage(completion.usage)
      };
    }

      const response = await this.client.responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.input,
          temperature: request.temperature,
          top_p: request.top_p,
          max_output_tokens: request.max_output_tokens
        },
        { timeout: opts.timeoutMs, maxRetries: opts.maxRetries }
      );

      const outputText = extractTextFromOpenAIResponse(response);
      const requestIdHeader = (response as unknown as { _request_id?: string })._request_id;
      const requestIdBody =
        (response as unknown as { request_id?: string }).request_id ??
        (response as unknown as { requestId?: string }).requestId;

      return {
        baseUrl: this.baseURL,
        endpoint: 'responses',
        model: request.model,
        outputText: typeof outputText === 'string' ? outputText : null,
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        attempt: opts.attempt,
        requestIdHeader,
        requestIdBody,
        responseId: (response as unknown as { id?: string }).id,
        usage: mapResponsesUsage(response)
      };
    } catch (error) {
      if (error instanceof APIConnectionTimeoutError) {
        const message = error.message || 'timeout';
        throw new LLMTimeoutError(message);
      }
      if (error instanceof APIError) {
        const e = new LLMAPIError(error.message);
        e.status = error.status;
        const requestIdFromError =
          (error as unknown as { request_id?: unknown }).request_id ??
          (error as unknown as { requestId?: unknown }).requestId;
        e.requestIdHeader = typeof requestIdFromError === 'string' ? requestIdFromError : undefined;
        throw e;
      }
      throw error;
    }
  }
}

export class LLMTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMAPIError extends Error {
  status?: number;
  requestIdHeader?: string;

  constructor(message: string) {
    super(message);
    this.name = 'LLMAPIError';
  }
}

export function extractTextFromOpenAIResponse(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const direct = coerceText(record.output_text ?? record.completion ?? record.text);
  if (direct) return direct;

  const parts: string[] = [];
  collectTextParts(record.content, parts);
  collectTextParts(record.message, parts);
  collectTextParts(record.choices, parts);
  collectTextParts(record.output, parts);
  if (parts.length === 0) {
    collectTextParts(record, parts);
  }

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

function mapChatUsage(
  usage: unknown
): LLMUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const anyUsage = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  return {
    inputTokens: typeof anyUsage.prompt_tokens === 'number' ? anyUsage.prompt_tokens : undefined,
    outputTokens: typeof anyUsage.completion_tokens === 'number' ? anyUsage.completion_tokens : undefined,
    totalTokens: typeof anyUsage.total_tokens === 'number' ? anyUsage.total_tokens : undefined
  };
}

function mapResponsesUsage(response: unknown): LLMUsage | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const anyUsage = usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  return {
    inputTokens: typeof anyUsage.input_tokens === 'number' ? anyUsage.input_tokens : undefined,
    outputTokens: typeof anyUsage.output_tokens === 'number' ? anyUsage.output_tokens : undefined,
    totalTokens: typeof anyUsage.total_tokens === 'number' ? anyUsage.total_tokens : undefined
  };
}
