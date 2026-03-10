import { LLMTimeoutError } from './OpenAISdkClient.js';
import type { LLMCallError } from './types.js';

export function mapLLMError(error: unknown): LLMCallError {
  if (error instanceof LLMTimeoutError) {
    return { type: 'timeout', message: error.message };
  }

  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string' &&
    (error as { name: string }).name === 'AbortError'
  ) {
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'timeout';
    return { type: 'timeout', message };
  }

  if (error && typeof error === 'object') {
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'unknown_error';
    const status =
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined;
    const type =
      typeof (error as { type?: unknown }).type === 'string'
        ? (error as { type: string }).type
        : 'error';
    return { type, status, message };
  }

  return { type: 'error', message: String(error) };
}

export function extractErrorRequestIdHeader(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate =
    (error as { requestIdHeader?: unknown }).requestIdHeader ??
    (error as { request_id?: unknown }).request_id ??
    (error as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' ? candidate : undefined;
}
