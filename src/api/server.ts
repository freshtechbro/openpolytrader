import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { isAuthorized, queryFlag } from '../security/Auth.js';

import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricEvent } from '../telemetry/metrics.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { OpsAgent } from '../agents/ops/OpsAgent.js';
import type { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { LearningAgent } from '../agents/learning/LearningAgent.js';
import type { ConfigStore } from '../config/store.js';
import type { TradingMode } from '../config/env.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { TradingStateManager } from '../core/TradingStateManager.js';
import type { PolymarketClob, MarketInfo } from '../services/PolymarketClob.js';
import { CONFIG_SCHEMA, buildUpdateSchema, getConfigSection } from '../config/schema.js';
import type { InfraConfigSnapshot } from '../config/infra.js';
import type { EventStore } from '../core/EventStore.js';
import { computeSloAggregates } from '../agents/ops/sloAggregates.js';
import type { SyntheticOpportunityOptions, SyntheticOpportunityResult } from '../core/Supervisor.js';
import { isRiskProfileId, RISK_PROFILE_IDS, type RiskProfileId } from '../config/riskProfile.js';

export interface OpsServerDeps {
  metrics: MetricsStore;
  allowlist: MarketAllowlist;
  opsAgent: OpsAgent;
  eventStore?: EventStore;
  portfolioAgent?: PortfolioAgent;
  learningAgent?: LearningAgent;
  configStore?: ConfigStore;
  tradingMode?: TradingMode;
  tradingEnabled?: boolean;
  tradingStateManager?: TradingStateManager;
  infraConfig?: InfraConfigSnapshot;
  clobClient?: PolymarketClob;
  syntheticOpportunity?: (options: SyntheticOpportunityOptions) => Promise<SyntheticOpportunityResult>;
  debugMarketDataOutlier?: (tokenId: string) => Promise<{ ok: boolean; error?: string }>;
  riskProfile?: { id: RiskProfileId; source: string };
  applyRiskProfile?: (
    profile: RiskProfileId,
    overridePath?: string
  ) => {
    profile: { id: RiskProfileId; source: string };
    policy: TradePolicy;
    risk: RiskConfig;
    persisted: boolean;
  };
  applyConfigUpdate?: (policy: TradePolicy, risk: RiskConfig) => void;
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
  let riskProfileState = deps.riskProfile;
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

  const marketInfoCache = new Map<string, MarketInfo | null>();

  app.get('/markets', async () => {
    const allowlistEntries = deps.allowlist.list();
    
    if (!deps.clobClient) {
      return allowlistEntries.map((entry) => ({
        ...entry,
        question: null,
        description: null
      }));
    }

    const enrichedEntries = await Promise.all(
      allowlistEntries.map(async (entry) => {
        const marketId = entry.key;
        
        if (!marketInfoCache.has(marketId)) {
          try {
            const info = await deps.clobClient!.getMarket(marketId);
            marketInfoCache.set(marketId, info);
          } catch {
            marketInfoCache.set(marketId, null);
          }
        }

        const cachedInfo = marketInfoCache.get(marketId);
        return {
          ...entry,
          question: cachedInfo?.question ?? null,
          description: cachedInfo?.description ?? null
        };
      })
    );

    return enrichedEntries;
  });

  app.post('/allowlist/:marketId/resume', async (request, reply) => {
    const marketId = (request.params as { marketId?: string }).marketId?.trim();
    if (!marketId) {
      reply.code(400);
      return { error: 'missing_market_id' };
    }

    deps.allowlist.allow(marketId);
    deps.metrics.record({
      type: 'allowlist_updated',
      timestamp: Date.now(),
      data: { marketId, action: 'allow' }
    });
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

  app.post('/debug/learning/synthesize', async (_request, reply) => {
    if (!deps.learningAgent) {
      reply.code(503);
      return { error: 'learning_agent_not_configured' };
    }
    await deps.learningAgent.synthesizeNow();
    return { ok: true };
  });

  app.post('/debug/portfolio/analyze', async (_request, reply) => {
    if (!deps.portfolioAgent) {
      reply.code(503);
      return { error: 'portfolio_agent_not_configured' };
    }
    await deps.portfolioAgent.analyzeAnomalies();
    return { ok: true };
  });

  app.post('/debug/marketdata/outlier', async (request, reply) => {
    if (!deps.debugMarketDataOutlier) {
      reply.code(503);
      return { error: 'marketdata_debug_not_configured' };
    }

    const body = request.body as { tokenId?: string } | undefined;
    const tokenId = typeof body?.tokenId === 'string' ? body.tokenId.trim() : '';
    if (!tokenId) {
      reply.code(400);
      return { error: 'missing_token_id' };
    }

    const result = await deps.debugMarketDataOutlier(tokenId);
    if (!result.ok) {
      reply.code(400);
      return { ok: false, error: result.error ?? 'marketdata_outlier_failed' };
    }

    return { ok: true };
  });

  app.post('/debug/synthetic-opportunity', async (request, reply) => {
    if (!deps.syntheticOpportunity) {
      reply.code(503);
      return { error: 'synthetic_opportunity_not_configured' };
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const executionMode = parseTradingMode(body.executionMode);

    const options: SyntheticOpportunityOptions = {
      marketId: asString(body.marketId),
      yesPrice: asNumber(body.yesPrice),
      noPrice: asNumber(body.noPrice),
      costPerSet: asNumber(body.costPerSet),
      edge: asNumber(body.edge),
      tickSize: asNumber(body.tickSize),
      minOrderSize: asNumber(body.minOrderSize),
      maxSizeByDepth: asNumber(body.maxSizeByDepth),
      execute: body.execute === true,
      executionMode: executionMode ?? undefined
    };

    const result = await deps.syntheticOpportunity(options);
    if (!result.ok) {
      reply.code(400);
    }
    return result;
  });

  app.get('/decisions', async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503);
      return { error: 'event_store_not_configured' };
    }

    const query = request.query as Record<string, unknown> | undefined;
    const agent = typeof query?.agent === 'string' ? query.agent.trim() : '';
    const subjectId = typeof query?.subjectId === 'string' ? query.subjectId.trim() : '';

    const limitRaw = queryPositiveInt(request, 'limit');
    const limit = Math.min(limitRaw ?? 200, 1000);

    const sinceMs = queryNonNegativeInt(request, 'sinceMs');
    const untilMs = queryNonNegativeInt(request, 'untilMs');

    return deps.eventStore.listDecisions({
      agent: agent.length > 0 ? agent : undefined,
      subjectId: subjectId.length > 0 ? subjectId : undefined,
      sinceMs: sinceMs ?? undefined,
      untilMs: untilMs ?? undefined,
      limit
    });
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
    
    const tradingState = deps.tradingStateManager?.state;
    
    return {
      ...configStore.snapshot(),
      riskProfile: riskProfileState?.id ?? 'extra_high',
      riskProfileSource: riskProfileState?.source ?? 'defaults',
      tradingMode: tradingState?.mode ?? deps.tradingMode,
      tradingEnabled: tradingState?.enabled ?? deps.tradingEnabled,
      tradingStateChangedAt: tradingState?.changedAt,
      tradingStateChangedBy: tradingState?.changedBy
    };
  });

  app.get('/config/risk-profiles', async () => {
    return {
      activeProfile: riskProfileState?.id ?? 'extra_high',
      activeProfileSource: riskProfileState?.source ?? 'defaults',
      availableProfiles: RISK_PROFILE_IDS
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
      deps.applyConfigUpdate?.(configStore.getPolicy(), configStore.getRisk());
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
      deps.applyConfigUpdate?.(configStore.getPolicy(), configStore.getRisk());
      return { risk: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return { error: 'invalid_risk_update', message };
    }
  });

  app.post('/config/risk-profile', async (request, reply) => {
    if (!configStore || !deps.applyRiskProfile) {
      reply.code(503);
      return { error: 'risk_profile_not_configured' };
    }

    const body = (request.body ?? {}) as { profile?: string; path?: string };
    const rawProfile = typeof body.profile === 'string' ? body.profile.trim().toLowerCase().replace(/-/g, '_') : '';
    if (!rawProfile || !isRiskProfileId(rawProfile)) {
      reply.code(400);
      return { error: 'invalid_profile', validProfiles: RISK_PROFILE_IDS };
    }

    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const overridePath = rawPath.length > 0 ? rawPath : undefined;

    try {
      const result = deps.applyRiskProfile(rawProfile, overridePath);
      riskProfileState = result.profile;
      return {
        ok: true,
        profile: result.profile,
        policy: result.policy,
        risk: result.risk,
        persisted: result.persisted
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return { error: 'risk_profile_apply_failed', message };
    }
  });

  app.post('/config/trading-mode', async (request, reply) => {
    if (!deps.tradingStateManager) {
      reply.code(503);
      return { error: 'trading_state_manager_not_configured' };
    }

    const body = request.body as { mode?: string; enabled?: boolean } | undefined;
    const validModes = ['off', 'shadow', 'paper', 'live'] as const;

    if (body?.mode !== undefined) {
      if (!validModes.includes(body.mode as typeof validModes[number])) {
        reply.code(400);
        return { error: 'invalid_mode', validModes };
      }

      if (body.mode === 'live') {
        const confirm = (request.query as { confirm?: string })?.confirm;
        if (confirm !== 'true') {
          reply.code(400);
          return { 
            error: 'live_mode_requires_confirmation',
            message: 'Add ?confirm=true to enable live trading'
          };
        }
      }

      deps.tradingStateManager.setMode(body.mode as typeof validModes[number]);
    }

    if (body?.enabled !== undefined) {
      deps.tradingStateManager.setEnabled(Boolean(body.enabled));
    }

    deps.metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: { 
        message: 'trading_state_changed',
        state: deps.tradingStateManager.state
      }
    });

    return { 
      ok: true, 
      state: deps.tradingStateManager.state 
    };
  });

  app.get('/stream', async (request, reply) => {
    const origin = request.headers.origin;
    reply.raw.setHeader('Access-Control-Allow-Origin', typeof origin === 'string' ? origin : '*');
    reply.raw.setHeader('Vary', 'Origin');
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    const writeEvent = (event: MetricEvent, name: string = event.type) => {
      reply.raw.write(`event: ${name}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const sseNameFor = (event: MetricEvent) => (event.type === 'error' ? 'metric_error' : event.type);
    const maxPings = queryPositiveInt(request, 'maxPings');

    writeEvent({
      type: 'info',
      timestamp: Date.now(),
      data: { message: 'stream_connected' }
    }, 'info');

    if (queryFlag(request, 'once')) {
      reply.raw.end();
      return;
    }

    const handler = (event: MetricEvent) => writeEvent(event, sseNameFor(event));
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

function queryNonNegativeInt(request: Parameters<typeof queryFlag>[0], key: string): number | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const raw = value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function parseTradingMode(value: unknown): TradingMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized === 'off' || normalized === 'shadow' || normalized === 'paper' || normalized === 'live') {
    return normalized;
  }
  return null;
}
