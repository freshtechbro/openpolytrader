import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { isAuthorized, queryFlag, readCookieValue, tokensMatch } from '../security/Auth.js';

import type { OpsErrorResponse } from './contracts.js';

type OpsErrorBuilder = (
  code: string,
  options?: { message?: string; details?: unknown }
) => OpsErrorResponse;

type OpsErrorSender = (
  reply: FastifyReply,
  status: number,
  code: string,
  options?: { message?: string; details?: unknown }
) => OpsErrorResponse;

type SessionRecord = { id: string; expiresAt: number };
type OpsAuthPolicy = 'public' | 'protected' | 'stream';

interface SessionContext {
  app: FastifyInstance;
  authRequired: boolean;
  authToken?: string;
  devSessionPrefillEnabled: boolean;
  sessionTtlMs: number;
  sessionCookieName: string;
  sessions: Map<string, number>;
  buildError: OpsErrorBuilder;
  sendError: OpsErrorSender;
}

export function registerOpsSessionSupport(context: SessionContext): void {
  registerOpsSessionAuth(context);
  registerOpsSessionRoutes(context);
}

export function opsAuthPolicyOptions(policy: OpsAuthPolicy): RouteShorthandOptions {
  return { config: { opsAuth: policy } };
}

function registerOpsSessionAuth(context: SessionContext): void {
  if (!context.authRequired) return;

  context.app.addHook('onRequest', async (request, reply) => {
    const policy = readOpsAuthPolicy(request);
    if (policy === 'public') {
      return;
    }

    if (
      !isAuthorized(request, context.authToken, { allowQueryToken: policy === 'stream' }) &&
      !hasSession(request, context.sessionCookieName, context.sessions)
    ) {
      return reply.code(401).send(context.buildError('unauthorized'));
    }
  });
}

function registerOpsSessionRoutes(context: SessionContext): void {
  const expectedToken = context.authToken?.trim();

  context.app.get('/ops/session', opsAuthPolicyOptions('public'), async (request) =>
    getOpsSessionState(context, request, expectedToken)
  );
  context.app.post('/ops/session', opsAuthPolicyOptions('public'), async (request, reply) =>
    createOpsSession(context, request, reply, expectedToken)
  );
  context.app.delete('/ops/session', opsAuthPolicyOptions('public'), async (request, reply) =>
    clearOpsSession(context, request, reply)
  );
}

function getOpsSessionState(
  context: SessionContext,
  request: FastifyRequest,
  expectedToken: string | undefined
) {
  const prefillToken = shouldPrefillToken(request, context) ? expectedToken : undefined;

  if (!context.authRequired) {
    return { authenticated: true, authRequired: false, prefillToken: undefined };
  }

  if (isAuthorized(request, expectedToken)) {
    return {
      authenticated: true,
      authRequired: true,
      prefillToken
    };
  }

  const session = getSession(request, context.sessionCookieName, context.sessions);
  return {
    authenticated: session !== null,
    authRequired: true,
    expiresAt: session?.expiresAt,
    prefillToken
  };
}

function createOpsSession(
  context: SessionContext,
  request: FastifyRequest,
  reply: FastifyReply,
  expectedToken: string | undefined
) {
  if (!context.authRequired) {
    return { authenticated: true, authRequired: false };
  }

  if (!expectedToken) {
    return context.sendError(reply, 503, 'auth_token_not_configured');
  }

  const token = readSubmittedToken(request.body);
  if (!token || !tokensMatch(token, expectedToken)) {
    return context.sendError(reply, 401, 'unauthorized');
  }

  const sessionId = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + context.sessionTtlMs;
  context.sessions.set(sessionId, expiresAt);

  reply.header(
    'Set-Cookie',
    buildSessionCookie(
      sessionId,
      request,
      context.sessionCookieName,
      Math.floor(context.sessionTtlMs / 1000)
    )
  );

  return { authenticated: true, authRequired: true, expiresAt };
}

function clearOpsSession(context: SessionContext, request: FastifyRequest, reply: FastifyReply) {
  const sessionId = readCookieValue(request, context.sessionCookieName);
  if (sessionId) {
    context.sessions.delete(sessionId);
  }
  reply.header('Set-Cookie', buildSessionCookie('', request, context.sessionCookieName, 0));
  return { authenticated: false, authRequired: context.authRequired };
}

function shouldPrefillToken(request: FastifyRequest, context: SessionContext): boolean {
  return queryFlag(request, 'prefill') && context.devSessionPrefillEnabled && isLoopbackRequest(request);
}

function readSubmittedToken(body: unknown): string {
  const payload = (body ?? {}) as { token?: unknown };
  return typeof payload.token === 'string' ? payload.token.trim() : '';
}

function getSession(
  request: FastifyRequest,
  sessionCookieName: string,
  sessions: Map<string, number>
): SessionRecord | null {
  const sessionId = readCookieValue(request, sessionCookieName);
  if (!sessionId) return null;
  const expiresAt = sessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, expiresAt };
}

function hasSession(
  request: FastifyRequest,
  sessionCookieName: string,
  sessions: Map<string, number>
): boolean {
  return getSession(request, sessionCookieName, sessions) !== null;
}

function buildSessionCookie(
  value: string,
  request: FastifyRequest,
  sessionCookieName: string,
  maxAgeSeconds: number
): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const secure =
    request.protocol === 'https' ||
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim() === 'https');
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  const hostHeader = request.headers.host;
  const host = parseHostName(hostHeader);
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    return false;
  }

  const normalizedIp = normalizeIp(request.ip);
  return normalizedIp === '127.0.0.1' || normalizedIp === '::1';
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function parseHostName(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('[')) {
    const endIndex = trimmed.indexOf(']');
    if (endIndex <= 1) return undefined;
    return trimmed.slice(1, endIndex);
  }
  return trimmed.split(':')[0];
}

function readOpsAuthPolicy(request: FastifyRequest): OpsAuthPolicy {
  const routeConfig = request.routeOptions?.config;
  if (!routeConfig || typeof routeConfig !== 'object') {
    return 'protected';
  }
  const policy = (routeConfig as unknown as Record<string, unknown>).opsAuth;
  return policy === 'public' || policy === 'stream' ? policy : 'protected';
}
