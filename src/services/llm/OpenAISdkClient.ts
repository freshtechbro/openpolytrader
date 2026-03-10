import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';

import { extractResponseText } from './extractResponseText.js';
import type { LLMCallResult, LLMRequest, LLMUsage } from './types.js';

interface OpenAISdkClientOptions {
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
            max_tokens: request.max_tokens,
            response_format: request.response_format
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

class LLMAPIError extends Error {
  status?: number;
  requestIdHeader?: string;

  constructor(message: string) {
    super(message);
    this.name = 'LLMAPIError';
  }
}

export function extractTextFromOpenAIResponse(value: unknown): string | null {
  return extractResponseText(value, { fallbackToRoot: true });
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
