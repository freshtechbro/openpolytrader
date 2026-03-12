import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  opsAuthPolicyOptions,
  registerOpsSessionSupport
} from '../../src/api/serverSession.js';
import type { OpsErrorResponse } from '../../src/api/contracts.js';

function createErrorResponse(
  code: string,
  options?: { message?: string; details?: unknown }
): OpsErrorResponse {
  return {
    error: {
      code,
      ...(options?.message ? { message: options.message } : {}),
      ...(options && 'details' in options ? { details: options.details } : {})
    }
  };
}

function buildSessionApp(overrides: Partial<{ authRequired: boolean; authToken?: string }> = {}) {
  const app = fastify();
  const sessions = new Map<string, number>();
  const context = {
    app,
    authRequired: overrides.authRequired ?? true,
    authToken: Object.prototype.hasOwnProperty.call(overrides, 'authToken')
      ? overrides.authToken
      : 'secret-token',
    devSessionPrefillEnabled: false,
    sessionTtlMs: 60_000,
    sessionCookieName: 'ops_session',
    sessions,
    buildError: createErrorResponse,
    sendError(reply, status, code, options) {
      const payload = createErrorResponse(code, options);
      reply.code(status).send(payload);
      return payload;
    }
  };

  registerOpsSessionSupport(context);

  app.get('/protected', async () => ({ ok: true }));
  app.get('/stream', opsAuthPolicyOptions('stream'), async () => ({ ok: true }));

  return { app, sessions, context };
}

afterEach(async () => {
  // handled per test to keep lifecycle explicit
});

describe('registerOpsSessionSupport', () => {
  it('reports unauthenticated session state and protects non-session routes', async () => {
    const { app } = buildSessionApp();

    try {
      const status = await app.inject({ method: 'GET', url: '/ops/session' });
      const protectedRoute = await app.inject({ method: 'GET', url: '/protected' });

      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        authenticated: false,
        authRequired: true
      });
      expect(protectedRoute.statusCode).toBe(401);
      expect(protectedRoute.json()).toMatchObject({
        error: { code: 'unauthorized' }
      });
    } finally {
      await app.close();
    }
  });

  it('creates, accepts, and clears cookie-backed ops sessions directly', async () => {
    const { app, sessions } = buildSessionApp();

    try {
      const login = await app.inject({
        method: 'POST',
        url: '/ops/session',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { token: 'secret-token' }
      });

      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({
        authenticated: true,
        authRequired: true
      });

      const setCookie = login.headers['set-cookie'];
      expect(typeof setCookie).toBe('string');
      expect(setCookie).toContain('ops_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(sessions.size).toBe(1);

      const cookie = (setCookie as string).split(';')[0];
      const protectedRoute = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { cookie }
      });
      expect(protectedRoute.statusCode).toBe(200);
      expect(protectedRoute.json()).toEqual({ ok: true });

      const logout = await app.inject({
        method: 'DELETE',
        url: '/ops/session',
        headers: { cookie }
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.headers['set-cookie']).toContain('Max-Age=0');
      expect(sessions.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('limits query token auth to the stream route', async () => {
    const { app } = buildSessionApp();

    try {
      const protectedRoute = await app.inject({
        method: 'GET',
        url: '/protected?token=secret-token'
      });
      const streamWithoutToken = await app.inject({ method: 'GET', url: '/stream' });
      const streamWithQueryToken = await app.inject({
        method: 'GET',
        url: '/stream?token=secret-token'
      });

      expect(protectedRoute.statusCode).toBe(401);
      expect(streamWithoutToken.statusCode).toBe(401);
      expect(streamWithQueryToken.statusCode).toBe(200);
      expect(streamWithQueryToken.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('omits secure on plain-http session cookies', async () => {
    const { app } = buildSessionApp();

    try {
      const login = await app.inject({
        method: 'POST',
        url: '/ops/session',
        payload: { token: 'secret-token' }
      });

      expect(login.statusCode).toBe(200);
      expect(String(login.headers['set-cookie'])).not.toContain('Secure');
    } finally {
      await app.close();
    }
  });

  it('rejects session creation when auth is required but no expected token is configured', async () => {
    const { app } = buildSessionApp({ authToken: undefined });

    try {
      const login = await app.inject({
        method: 'POST',
        url: '/ops/session',
        payload: { token: 'secret-token' }
      });

      expect(login.statusCode).toBe(503);
      expect(login.json()).toMatchObject({
        error: { code: 'auth_token_not_configured' }
      });
    } finally {
      await app.close();
    }
  });
});
