import { OPS_BASE_URL } from './dashboardConfig';
import type { OpsErrorResponse } from '../../../src/api/contracts.js';

export const OPS_BASE = OPS_BASE_URL;
export const OPS_STREAM_URL = buildOpsUrl('/stream');

const OPS_SESSION_PATH = '/ops/session';
const OPS_SESSION_HEADER = 'x-ops-token';

let opsAuthToken: string | null = null;

interface OpsSessionStatus {
  authenticated: boolean;
  authRequired: boolean;
  expiresAt?: number;
  prefillToken?: string;
}

export class OpsRequestError extends Error {
  readonly path: string;
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(path: string, status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'OpsRequestError';
    this.path = path;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalidJsonError(path: string, status: number): OpsRequestError {
  return new OpsRequestError(path, status, 'invalid_json', `Invalid JSON response for ${path}`);
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

function opsFetchResponse(path: string, init?: RequestInit): Promise<Response> {
  const headers = toHeaders(init?.headers);
  if (opsAuthToken && !headers.has('authorization') && !headers.has(OPS_SESSION_HEADER)) {
    headers.set(OPS_SESSION_HEADER, opsAuthToken);
  }
  const hasHeaders = Array.from(headers.keys()).length > 0;
  return fetch(buildOpsUrl(path), {
    ...init,
    headers: hasHeaders ? headers : undefined,
    credentials: 'include'
  });
}

export async function opsFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await opsFetchResponse(path, init);
  const text = await response.text();
  const trimmed = text.trim();
  const parsed = trimmed.length > 0 ? safeParseJSON(text) : undefined;

  if (!response.ok) {
    const error = parseOpsError(parsed, response.status);
    throw new OpsRequestError(path, response.status, error.code, error.message, error.details);
  }

  if (trimmed.length === 0 || parsed === null) {
    throw invalidJsonError(path, response.status);
  }

  return parsed as T;
}

export function isOpsUnauthorizedError(error: unknown): boolean {
  if (error instanceof OpsRequestError) {
    return error.status === 401 || error.code === 'unauthorized';
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
  await opsFetchJson<OpsSessionStatus>(OPS_SESSION_PATH, { method: 'DELETE' });
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

function parseOpsError(parsed: unknown, status: number): { code: string; message?: string; details?: unknown } {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const response = parsed as Partial<OpsErrorResponse>;
    const error = response.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const record = error as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : `http_${status}`;
      const message = typeof record.message === 'string' ? record.message : undefined;
      const details = 'details' in record ? record.details : undefined;
      return { code, message, details };
    }
  }
  return { code: `http_${status}` };
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
