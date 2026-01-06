import { OPS_BASE_URL, OPS_TOKEN } from './dashboardConfig';

export const OPS_BASE = OPS_BASE_URL;
export const OPS_HEADERS = OPS_TOKEN ? { Authorization: `Bearer ${OPS_TOKEN}` } : undefined;
export const OPS_STREAM_URL = OPS_TOKEN
  ? `${OPS_BASE_URL}/stream?token=${encodeURIComponent(OPS_TOKEN)}`
  : `${OPS_BASE_URL}/stream`;

export function opsFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = OPS_HEADERS
    ? { ...(init?.headers ?? {}), ...OPS_HEADERS }
    : init?.headers;
  return fetch(`${OPS_BASE_URL}${path}`, { ...init, headers });
}

export async function opsFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await opsFetch(path, init);
  return (await response.json()) as T;
}
