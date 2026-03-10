import type { FastifyInstance } from 'fastify';

import { computeSloAggregates } from '../agents/ops/sloAggregates.js';
import type { OpsPortfolioSnapshot } from './contracts.js';
import type { HealthAndMetricsRouteContext } from './serverRouteContext.js';

export function registerHealthAndMetricsRoutes(
  app: FastifyInstance,
  context: HealthAndMetricsRouteContext
): void {
  app.get('/health', handleHealthReport.bind(null, context));
  app.get('/health/live', handleLiveHealthReport);
  app.get('/health/ready', handleReadinessReport.bind(null, context));
  app.get('/metrics', handleMetricsSnapshot.bind(null, context));
  app.get('/allowlist', handleAllowlistSnapshot.bind(null, context));
  app.get('/incidents', handleIncidentsSnapshot.bind(null, context));
  app.get('/slo', handleSloReport.bind(null, context));
  app.get('/portfolio', handlePortfolioSnapshot.bind(null, context));
}

function handleHealthReport(context: HealthAndMetricsRouteContext) {
  return context.deps.opsAgent.getReport();
}

function handleLiveHealthReport() {
  return { live: true, uptimeMs: Math.round(process.uptime() * 1000) };
}

function handleReadinessReport(
  context: HealthAndMetricsRouteContext,
  _request: unknown,
  reply: { code: (status: number) => void }
) {
  return context.deps.opsAgent.runOnce().then((report) => {
    const ready = report.status === 'healthy' && Object.values(report.checks).every((check) => check.ok);
    reply.code(ready ? 200 : 503);
    return { ready, report };
  });
}

function handleMetricsSnapshot(context: HealthAndMetricsRouteContext) {
  return context.deps.metrics.snapshot();
}

function handleAllowlistSnapshot(context: HealthAndMetricsRouteContext) {
  return context.deps.allowlist.list();
}

function handleIncidentsSnapshot(context: HealthAndMetricsRouteContext) {
  return context.deps.metrics.recent('incident', context.incidentsLimit);
}

function handleSloReport(
  context: HealthAndMetricsRouteContext,
  _request: unknown,
  reply: Parameters<HealthAndMetricsRouteContext['sendError']>[0]
) {
  if (!context.deps.eventStore) {
    return context.sendError(reply, 503, 'event_store_not_configured');
  }

  try {
    return computeSloAggregates(context.deps.eventStore);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.sendError(reply, 500, 'slo_compute_failed', { message });
  }
}

function handlePortfolioSnapshot(
  context: HealthAndMetricsRouteContext,
  _request: unknown,
  reply: Parameters<HealthAndMetricsRouteContext['sendError']>[0]
) {
  if (!context.deps.portfolioAgent) {
    return context.sendError(reply, 503, 'portfolio_agent_not_configured');
  }
  const snapshot = context.deps.portfolioAgent.snapshot();
  const response: OpsPortfolioSnapshot = {
    ...snapshot,
    openInventoryAgeMs: snapshot.openInventoryAgeMs ?? 0
  };
  return response;
}
