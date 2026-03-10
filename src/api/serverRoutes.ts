import type { FastifyInstance } from 'fastify';

import type { OpsServerRouteContexts } from './serverRouteContext.js';
import { registerDecisionAndConfigRoutes } from './serverRoutesDecisionConfig.js';
import { registerHealthAndMetricsRoutes } from './serverRoutesHealth.js';
import { registerMarketAndDebugRoutes } from './serverRoutesMarketDebug.js';
import { registerEventStreamRoute } from './serverRoutesStream.js';

export function registerOpsServerRoutes(app: FastifyInstance, contexts: OpsServerRouteContexts): void {
  registerHealthAndMetricsRoutes(app, contexts.healthAndMetrics);
  registerMarketAndDebugRoutes(app, contexts.marketAndDebug);
  registerDecisionAndConfigRoutes(app, contexts.decisionAndConfig);
  registerEventStreamRoute(app, contexts.eventStream);
}
