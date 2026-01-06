import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { isAuthorized, queryFlag } from '../security/Auth.js';

import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricEvent } from '../telemetry/metrics.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { OpsAgent } from '../agents/ops/OpsAgent.js';
import type { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { ConfigStore } from '../config/store.js';
import type { TradingMode } from '../config/env.js';
import { CONFIG_SCHEMA, buildUpdateSchema, getConfigSection } from '../config/schema.js';
import type { InfraConfigSnapshot } from '../config/infra.js';
import type { EventStore } from '../core/EventStore.js';
import { computeSloAggregates } from '../agents/ops/sloAggregates.js';

export interface OpsServerDeps {
  metrics: MetricsStore;
  allowlist: MarketAllowlist;
  opsAgent: OpsAgent;
  eventStore?: EventStore;
  portfolioAgent?: PortfolioAgent;
  configStore?: ConfigStore;
  tradingMode?: TradingMode;
  tradingEnabled?: boolean;
  infraConfig?: InfraConfigSnapshot;
}

export interface OpsServerOptions {
  authToken?: string;
  incidentsLimit: number;
  streamHeartbeatMs: number;
}

export interface OpsServerConfig {
  host: string;
  port: number;
  authToken?: string;
  incidentsLimit: number;
  streamHeartbeatMs: number;
}

export function createOpsServer(
  deps: OpsServerDeps,
  options: OpsServerOptions
): FastifyInstance {
  const app = Fastify({ logger: false });
  const authToken = options.authToken?.trim();
  const configStore = deps.configStore;
  const incidentsLimit = options.incidentsLimit;
  const streamHeartbeatMs = options.streamHeartbeatMs;

  void app.register(cors, {
    origin: true,
    allowedHeaders: ['authorization', 'content-type', 'x-ops-token']
  });

  if (authToken) {
    app.addHook('onRequest', async (request, reply) => {
      if (!isAuthorized(request, authToken)) {
        reply.code(401);
        return reply.send({ error: 'unauthorized' });
      }
    });
  }

  app.get('/health', async () => {
    return deps.opsAgent.getReport();
  });

  app.get('/health/live', async () => {
    return { live: true, uptimeMs: Math.round(process.uptime() * 1000) };
  });

  app.get('/health/ready', async (_request, reply) => {
    const report = await deps.opsAgent.runOnce();
    const ready =
      report.status === 'healthy' &&
      Object.values(report.checks).every((check) => check.ok);
    reply.code(ready ? 200 : 503);
    return { ready, report };
  });

  app.get('/metrics', async () => {
    return deps.metrics.snapshot();
  });

  app.get('/slo', async (_request, reply) => {
    if (!deps.eventStore) {
      reply.code(503);
      return { error: 'event_store_not_configured' };
    }

    try {
      return computeSloAggregates(deps.eventStore);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return { error: 'slo_compute_failed', message };
    }
  });

  app.get('/allowlist', async () => {
    return deps.allowlist.list();
  });

  app.post('/allowlist/:marketId/resume', async (request, reply) => {
    const marketId = (request.params as { marketId?: string }).marketId?.trim();
    if (!marketId) {
      reply.code(400);
      return { error: 'missing_market_id' };
    }

    deps.allowlist.allow(marketId);
    deps.metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: { message: 'allowlist_resumed', marketId }
    });

    return { ok: true, marketId, status: deps.allowlist.getStatus(marketId) };
  });

  app.get('/incidents', async () => {
    return deps.metrics.recent('incident', incidentsLimit);
  });

  app.get('/portfolio', async () => {
    if (!deps.portfolioAgent) {
      return { error: 'portfolio agent not configured' };
    }
    return deps.portfolioAgent.snapshot();
  });

  const policySection = getConfigSection('policy');
  const riskSection = getConfigSection('risk');
  if (!policySection || !riskSection) {
    throw new Error('Config schema missing policy or risk sections');
  }

  const policyUpdateSchema = buildUpdateSchema(policySection.fields).partial().strict();
  const riskUpdateSchema = buildUpdateSchema(riskSection.fields).partial().strict();

  app.get('/config', async (_request, reply) => {
    if (!configStore) {
      reply.code(503);
      return { error: 'config_store_not_configured' };
    }
    return {
      ...configStore.snapshot(),
      tradingMode: deps.tradingMode,
      tradingEnabled: deps.tradingEnabled
    };
  });

  app.get('/config/schema', async () => {
    return CONFIG_SCHEMA;
  });

  app.get('/config/infra', async (_request, reply) => {
    if (!deps.infraConfig) {
      reply.code(503);
      return { error: 'infra_config_not_configured' };
    }
    return deps.infraConfig;
  });

  app.patch('/config/policy', async (request, reply) => {
    if (!configStore) {
      reply.code(503);
      return { error: 'config_store_not_configured' };
    }
    const parsed = policyUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_policy_update', issues: parsed.error.issues };
    }
    try {
      const updated = configStore.updatePolicy(parsed.data);
      return { policy: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return { error: 'invalid_policy_update', message };
    }
  });

  app.patch('/config/risk', async (request, reply) => {
    if (!configStore) {
      reply.code(503);
      return { error: 'config_store_not_configured' };
    }
    const parsed = riskUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_risk_update', issues: parsed.error.issues };
    }
    try {
      const updated = configStore.updateRisk(parsed.data);
      return { risk: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return { error: 'invalid_risk_update', message };
    }
  });

  app.get('/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const writeEvent = (event: MetricEvent, name = event.type) => {
      reply.raw.write(`event: ${name}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const maxPings = queryPositiveInt(request, 'maxPings');

    writeEvent({
      type: 'info',
      timestamp: Date.now(),
      data: { message: 'stream_connected' }
    });

    if (queryFlag(request, 'once')) {
      reply.raw.end();
      return;
    }

    const handler = (event: MetricEvent) => writeEvent(event);
    deps.metrics.on('event', handler);

    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let pingCount = 0;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      deps.metrics.off('event', handler);
    };

    heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
      pingCount += 1;

      if (maxPings !== null && pingCount >= maxPings) {
        cleanup();
        reply.raw.end();
      }
    }, streamHeartbeatMs);

    reply.raw.on('close', cleanup);
    reply.raw.on('finish', cleanup);
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
    incidentsLimit: config.incidentsLimit,
    streamHeartbeatMs: config.streamHeartbeatMs
  });
  await listen(app, config);
  return app;
}

async function defaultOpsServerListen(app: FastifyInstance, config: OpsServerConfig): Promise<void> {
  await app.listen({ port: config.port, host: config.host });
}

function queryPositiveInt(request: Parameters<typeof queryFlag>[0], key: string): number | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const raw = value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
