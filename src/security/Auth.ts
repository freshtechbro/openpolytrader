import { timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

interface AuthorizationOptions {
  allowQueryToken?: boolean;
}

export function readOpsHeaderToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
  }

  const headerToken = request.headers['x-ops-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  return undefined;
}

export function readOpsQueryToken(request: FastifyRequest): string | undefined {
  const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}

export function readOpsToken(request: FastifyRequest): string | undefined {
  return readOpsHeaderToken(request) ?? readOpsQueryToken(request);
}

export function tokensMatch(token: string, expected: string): boolean {
  if (token.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function isAuthorized(
  request: FastifyRequest,
  expectedToken?: string,
  options: AuthorizationOptions = {}
): boolean {
  const expected = expectedToken?.trim();
  if (!expected) return true;

  const token =
    readOpsHeaderToken(request) ??
    (options.allowQueryToken ? readOpsQueryToken(request) : undefined);
  if (!token) return false;

  return tokensMatch(token, expected);
}

export function queryFlag(request: FastifyRequest, key: string): boolean {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true';
}

export function readCookieValue(request: FastifyRequest, key: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.trim().length === 0) return undefined;

  const cookies = header.split(';');
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split('=');
    if (!name) continue;
    if (name.trim() !== key) continue;
    const rawValue = valueParts.join('=').trim();
    if (rawValue.length === 0) return undefined;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}
