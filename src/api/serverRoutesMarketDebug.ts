import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseTradingMode, type OpsAllowlistResumeResponse } from './contracts.js';
import type { MarketAndDebugRouteContext } from './serverRouteContext.js';
import type { OpsMarketInfo } from './serverTypes.js';

export function registerMarketAndDebugRoutes(
  app: FastifyInstance,
  context: MarketAndDebugRouteContext
): void {
  const marketInfoCache = new Map<string, OpsMarketInfo | null>();
  registerMarketRoutes(app, context, marketInfoCache);
  registerDebugRoutes(app, context);
}

function registerMarketRoutes(
  app: FastifyInstance,
  context: MarketAndDebugRouteContext,
  marketInfoCache: Map<string, OpsMarketInfo | null>
): void {
  app.get('/markets', handleMarketList.bind(null, context, marketInfoCache));
  app.post('/allowlist/:marketId/resume', handleAllowlistResume.bind(null, context));
}

function registerDebugRoutes(app: FastifyInstance, context: MarketAndDebugRouteContext): void {
  app.post('/debug/learning/synthesize', handleLearningSynthesize.bind(null, context));
  app.post('/debug/portfolio/analyze', handlePortfolioAnalyze.bind(null, context));
  app.post('/debug/marketdata/outlier', handleMarketDataOutlier.bind(null, context));
  app.post('/debug/synthetic-opportunity', handleSyntheticOpportunity.bind(null, context));
}

function handleMarketList(
  context: MarketAndDebugRouteContext,
  marketInfoCache: Map<string, OpsMarketInfo | null>
) {
  const allowlistEntries = context.deps.allowlist.list();
  const clobClient = context.deps.clobClient;
  if (!clobClient) {
    return allowlistEntries.map((entry) => ({ ...entry, question: null, description: null }));
  }

  return Promise.all(
    allowlistEntries.map((entry) =>
      getCachedMarketSummary(entry.key, marketInfoCache, clobClient).then((summary) => ({
        ...entry,
        ...summary
      }))
    )
  );
}

function handleAllowlistResume(
  context: MarketAndDebugRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const marketId = (request.params as { marketId?: string }).marketId?.trim();
  if (!marketId) {
    return context.sendError(reply, 400, 'missing_market_id');
  }

  context.deps.allowlist.allow(marketId);
  context.deps.metrics.record({
    type: 'allowlist_updated',
    timestamp: Date.now(),
    data: { marketId, action: 'allow' }
  });
  context.recordPrivilegedMutation('allowlist_resumed', { marketId });

  const response: OpsAllowlistResumeResponse = {
    marketId,
    status: context.deps.allowlist.getStatus(marketId)
  };
  return response;
}

async function handleLearningSynthesize(
  context: MarketAndDebugRouteContext,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.learningAgent) {
    return context.sendError(reply, 503, 'learning_agent_not_configured');
  }
  await context.deps.learningAgent.synthesizeNow();
  context.recordPrivilegedMutation('debug_learning_synthesized');
  return reply.code(204).send();
}

async function handlePortfolioAnalyze(
  context: MarketAndDebugRouteContext,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.portfolioAgent) {
    return context.sendError(reply, 503, 'portfolio_agent_not_configured');
  }
  await context.deps.portfolioAgent.analyzeAnomalies();
  context.recordPrivilegedMutation('debug_portfolio_analyzed');
  return reply.code(204).send();
}

async function handleMarketDataOutlier(
  context: MarketAndDebugRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.debugMarketDataOutlier) {
    return context.sendError(reply, 503, 'marketdata_debug_not_configured');
  }

  const body = request.body as { tokenId?: string } | undefined;
  const tokenId = typeof body?.tokenId === 'string' ? body.tokenId.trim() : '';
  if (!tokenId) {
    return context.sendError(reply, 400, 'missing_token_id');
  }

  const result = await context.deps.debugMarketDataOutlier(tokenId);
  if (!result.ok) {
    return context.sendError(reply, 400, result.error ?? 'marketdata_outlier_failed');
  }

  context.recordPrivilegedMutation('debug_marketdata_outlier', { tokenId });
  return reply.code(204).send();
}

async function handleSyntheticOpportunity(
  context: MarketAndDebugRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.syntheticOpportunity) {
    return context.sendError(reply, 503, 'synthetic_opportunity_not_configured');
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const execute = body.execute === true;
  const executionMode = parseTradingMode(body.executionMode) ?? undefined;
  const result = await context.deps.syntheticOpportunity({
    marketId: asString(body.marketId),
    yesPrice: asNumber(body.yesPrice),
    noPrice: asNumber(body.noPrice),
    costPerSet: asNumber(body.costPerSet),
    edge: asNumber(body.edge),
    tickSize: asNumber(body.tickSize),
    minOrderSize: asNumber(body.minOrderSize),
    maxSizeByDepth: asNumber(body.maxSizeByDepth),
    execute,
    executionMode
  });

  if (!result.ok) {
    return context.sendError(reply, 400, 'synthetic_opportunity_failed', {
      message: result.message,
      details: result
    });
  }

  if (execute) {
    context.recordPrivilegedMutation('debug_synthetic_opportunity_executed', {
      marketId: result.marketId ?? asString(body.marketId) ?? null,
      opportunityId: result.opportunityId,
      executionMode: executionMode ?? null
    });
  }

  return {
    marketId: result.marketId,
    opportunityId: result.opportunityId,
    ...(result.message ? { message: result.message } : {}),
    ...(result.opportunity ? { opportunity: result.opportunity } : {}),
    ...(result.riskDecision ? { riskDecision: result.riskDecision } : {}),
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.orderedIds ? { orderedIds: result.orderedIds } : {})
  };
}

function getCachedMarketSummary(
  marketId: string,
  cache: Map<string, OpsMarketInfo | null>,
  clobClient: NonNullable<MarketAndDebugRouteContext['deps']['clobClient']>
): Promise<{ question: string | null; description: string | null }> {
  if (cache.has(marketId)) {
    return Promise.resolve(toMarketSummary(cache.get(marketId) ?? null));
  }

  return clobClient
    .getMarket(marketId)
    .then((info) => {
      cache.set(marketId, info);
      return toMarketSummary(info);
    })
    .catch(() => {
      cache.set(marketId, null);
      return toMarketSummary(null);
    });
}

function toMarketSummary(info: OpsMarketInfo | null) {
  return {
    question: info?.question ?? null,
    description: info?.description ?? null
  };
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
