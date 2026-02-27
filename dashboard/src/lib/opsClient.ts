import { OPS_BASE_URL } from './dashboardConfig';

export const OPS_BASE = OPS_BASE_URL;
export const OPS_STREAM_URL = buildOpsUrl('/stream');

const OPS_SESSION_PATH = '/ops/session';

export interface OpsSessionStatus {
  authenticated: boolean;
  authRequired: boolean;
  expiresAt?: number;
  prefillToken?: string;
}

export class OpsRequestError extends Error {
  readonly path: string;
  readonly status: number;
  readonly reason: string;

  constructor(path: string, status: number, reason: string) {
    super(`${path}:${reason}`);
    this.name = 'OpsRequestError';
    this.path = path;
    this.status = status;
    this.reason = reason;
  }
}

export function buildOpsUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${OPS_BASE_URL}${normalizedPath}`;
}

export function opsFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = init?.headers ? { ...init.headers } : undefined;
  return fetch(buildOpsUrl(path), {
    ...init,
    headers,
    credentials: 'include'
  });
}

export async function opsFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await opsFetch(path, init);
  const text = await response.text();
  const parsed = text.trim().length > 0 ? safeParseJSON(text) : null;

  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).error === 'string'
        ? String((parsed as Record<string, unknown>).error)
        : `http_${response.status}`;
    throw new OpsRequestError(path, response.status, message);
  }

  return parsed as T;
}

export function isOpsUnauthorizedError(error: unknown): boolean {
  if (error instanceof OpsRequestError) {
    return error.status === 401;
  }
  if (error instanceof Error) {
    return error.message.endsWith(':unauthorized') || error.message.endsWith(':http_401');
  }
  return false;
}

export function getOpsSession(options?: { prefill?: boolean }): Promise<OpsSessionStatus> {
  const query = options?.prefill ? '?prefill=1' : '';
  return opsFetchJson<OpsSessionStatus>(`${OPS_SESSION_PATH}${query}`);
}

export function createOpsSession(token: string): Promise<OpsSessionStatus> {
  return opsFetchJson<OpsSessionStatus>(OPS_SESSION_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
}

export async function clearOpsSession(): Promise<void> {
  await opsFetch(OPS_SESSION_PATH, { method: 'DELETE' });
}

function safeParseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
