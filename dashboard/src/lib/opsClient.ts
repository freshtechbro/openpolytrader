import { OPS_BASE_URL } from './dashboardConfig';

export const OPS_BASE = OPS_BASE_URL;
export const OPS_STREAM_URL = buildOpsUrl('/stream');

const OPS_SESSION_PATH = '/ops/session';
const OPS_TOKEN_HEADER = 'x-ops-token';

let opsAuthToken: string | null = null;

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

export function getOpsStreamUrl(): string {
  const base = OPS_STREAM_URL;
  if (!opsAuthToken) return base;
  if (!shouldAppendStreamToken(base) && hasOpsSessionCookie()) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(opsAuthToken)}`;
}

export function opsFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = toHeaders(init?.headers);
  if (opsAuthToken && !headers.has('authorization') && !headers.has(OPS_TOKEN_HEADER)) {
    headers.set(OPS_TOKEN_HEADER, opsAuthToken);
  }
  const hasHeaders = Array.from(headers.keys()).length > 0;
  return fetch(buildOpsUrl(path), {
    ...init,
    headers: hasHeaders ? headers : undefined,
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

export function setOpsAuthToken(token: string | undefined | null): void {
  const normalized = typeof token === 'string' ? token.trim() : '';
  opsAuthToken = normalized.length > 0 ? normalized : null;
}

export function clearOpsAuthToken(): void {
  opsAuthToken = null;
}

function safeParseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toHeaders(input: HeadersInit | undefined): Headers {
  if (!input) return new Headers();
  return new Headers(input);
}

function shouldAppendStreamToken(streamUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const resolved = new URL(streamUrl, window.location.href);
    return resolved.hostname !== window.location.hostname;
  } catch {
    return false;
  }
}

function hasOpsSessionCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => part.trim().startsWith('ops_session='));
}
