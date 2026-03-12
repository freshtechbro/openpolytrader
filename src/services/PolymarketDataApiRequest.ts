import { safeParseJsonBody } from '../utils/serialization.js';

const DATA_API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'openpolytrader/0.1.0'
};

export class DataApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'DataApiError';
  }
}

export async function executeDataApiRequest<T>(input: {
  baseUrl: string;
  method: string;
  path: string;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(new URL(input.path, input.baseUrl).toString(), {
      method: input.method,
      headers: DATA_API_HEADERS,
      signal: controller.signal
    });
    const text = await response.text();
    const parsedResult = safeParseJsonBody(text);

    if (!response.ok) {
      throw new DataApiError(
        `Polymarket Data API error ${response.status} for ${input.method} ${input.path}`,
        response.status,
        parsedResult.failed ? { raw: text } : parsedResult.parsed
      );
    }

    if (parsedResult.failed) {
      const snippet = text.slice(0, 200);
      throw new Error(`Polymarket Data API invalid JSON for ${input.method} ${input.path}: ${snippet}`);
    }

    return parsedResult.parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}
