import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';

import { isAuthorized, queryFlag } from '../security/Auth.js';

import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricEvent } from '../telemetry/metrics.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { OpsAgent } from '../agents/ops/OpsAgent.js';
import type { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';

export interface OpsServerDeps {
  metrics: MetricsStore;
  allowlist: MarketAllowlist;
  opsAgent: OpsAgent;
  portfolioAgent?: PortfolioAgent;
}

export interface OpsServerOptions {
  authToken?: string;
}

export interface OpsServerConfig {
  host?: string;
  port: number;
  authToken?: string;
}

export function createOpsServer(
  deps: OpsServerDeps,
  options: OpsServerOptions = {}
): FastifyInstance {
  const app = Fastify({ logger: false });
  const authToken = options.authToken?.trim();

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

  app.get('/metrics', async () => {
    return deps.metrics.snapshot();
  });

  app.get('/allowlist', async () => {
    return deps.allowlist.list();
  });

  app.get('/incidents', async () => {
    return deps.metrics.recent('incident', 100);
  });

  app.get('/portfolio', async () => {
    if (!deps.portfolioAgent) {
      return { error: 'portfolio agent not configured' };
    }
    return deps.portfolioAgent.snapshot();
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

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      deps.metrics.off('event', handler);
    });
  });

  return app;
}

export async function startOpsServer(
  deps: OpsServerDeps,
  config: OpsServerConfig
): Promise<FastifyInstance> {
  const app = createOpsServer(deps, { authToken: config.authToken });
  await app.listen({ port: config.port, host: config.host ?? '0.0.0.0' });
  return app;
}

