import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { queryFlag } from '../security/Auth.js';

import type { TradingState } from '../core/TradingStateManager.js';
import { buildUpdateSchema, getConfigSection } from '../config/schema.js';
import type {
  OpsConfigSectionValues,
  OpsConfigValue,
  OpsErrorResponse,
  OpsTradingStateResponse
} from './contracts.js';
import { registerOpsServerRoutes } from './serverRoutes.js';
import { registerOpsSessionSupport } from './serverSession.js';
import type { OpsServerDeps } from './serverTypes.js';

export type { OpsServerDeps } from './serverTypes.js';

interface OpsServerOptions {
  authToken?: string;
  devSessionPrefillEnabled?: boolean;
  incidentsLimit: number;
  streamHeartbeatMs: number;
}

interface OpsServerConfig {
  host: string;
  port: number;
  authToken?: string;
  devSessionPrefillEnabled?: boolean;
  incidentsLimit: number;
  streamHeartbeatMs: number;
}

export function createOpsServer(
  deps: OpsServerDeps,
  options: OpsServerOptions
): FastifyInstance {
  const app = Fastify({ logger: false });
  const authToken = options.authToken?.trim();
  const authRequired = Boolean(authToken);
  const devSessionPrefillEnabled = Boolean(options.devSessionPrefillEnabled);
  const riskProfileStateRef = { current: deps.riskProfile };
  const incidentsLimit = options.incidentsLimit;
  const streamHeartbeatMs = options.streamHeartbeatMs;
  const sessionTtlMs = 1000 * 60 * 60 * 12;
  const sessionCookieName = 'ops_session';
  const sessions = new Map<string, number>();

  const toConfigSectionValues = <T extends object>(
    values: T
  ): OpsConfigSectionValues =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value as OpsConfigValue])
    );

  const serializeTradingState = (state: TradingState): OpsTradingStateResponse['state'] => ({
    enabled: state.enabled,
    mode: state.mode,
    changedAt: state.changedAt.toISOString(),
    changedBy: state.changedBy
  });

  const recordPrivilegedMutation = (
    action: string,
    details?: Record<string, unknown>
  ) => {
    deps.metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: {
        message: 'privileged_mutation_applied',
        action,
        ...(details ?? {})
      }
    });
  };

  void app.register(cors, {
    origin: true,
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-ops-token']
  });

  registerOpsSessionSupport({
    app,
    authRequired,
    authToken,
    devSessionPrefillEnabled,
    sessionTtlMs,
    sessionCookieName,
    sessions,
    buildError,
    sendError
  });

  const policySection = getConfigSection('policy');
  const riskSection = getConfigSection('risk');
  if (!policySection || !riskSection) {
    throw new Error('Config schema missing policy or risk sections');
  }

  const policyUpdateSchema = buildUpdateSchema(policySection.fields).partial().strict();
  const riskUpdateSchema = buildUpdateSchema(riskSection.fields).partial().strict();

  registerOpsServerRoutes(app, {
    healthAndMetrics: {
      deps,
      incidentsLimit,
      sendError
    },
    marketAndDebug: {
      deps,
      recordPrivilegedMutation,
      sendError
    },
    decisionAndConfig: {
      deps,
      riskProfileStateRef,
      policyUpdateSchema,
      riskUpdateSchema,
      sendError,
      toConfigSectionValues,
      serializeTradingState,
      recordPrivilegedMutation,
      queryPositiveInt: (request, key) => queryPositiveInt(request, key),
      queryNonNegativeInt: (request, key) => queryNonNegativeInt(request, key)
    },
    eventStream: {
      metrics: deps.metrics,
      streamHeartbeatMs,
      queryPositiveInt: (request, key) => queryPositiveInt(request, key)
    }
  });

  return app;
}

export async function startOpsServer(
  deps: OpsServerDeps,
  config: OpsServerConfig,
  listen: (app: FastifyInstance, config: OpsServerConfig) => Promise<void> = defaultOpsServerListen
): Promise<FastifyInstance> {
  const app = createOpsServer(deps, {
    authToken: config.authToken,
    devSessionPrefillEnabled: config.devSessionPrefillEnabled,
    incidentsLimit: config.incidentsLimit,
    streamHeartbeatMs: config.streamHeartbeatMs
  });
  await listen(app, config);
  return app;
}

async function defaultOpsServerListen(app: FastifyInstance, config: OpsServerConfig): Promise<void> {
  await app.listen({ port: config.port, host: config.host });
}

function buildError(
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

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  options?: { message?: string; details?: unknown }
): OpsErrorResponse {
  reply.code(status);
  return buildError(code, options);
}

function queryPositiveInt(request: Parameters<typeof queryFlag>[0], key: string): number | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const raw = value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function queryNonNegativeInt(request: Parameters<typeof queryFlag>[0], key: string): number | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const raw = value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}
