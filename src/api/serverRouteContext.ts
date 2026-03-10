import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { RiskProfileId } from '../config/riskProfile.js';
import type { OpsConfigSectionValues, OpsErrorResponse, OpsTradingStateResponse } from './contracts.js';
import type { OpsServerDeps } from './serverTypes.js';

export type UpdateSchema = z.ZodObject<Record<string, z.ZodTypeAny>>;
export type SendOpsError = (
  reply: FastifyReply,
  status: number,
  code: string,
  options?: { message?: string; details?: unknown }
) => OpsErrorResponse;

export interface RiskProfileStateRef {
  current?: { id: RiskProfileId; source: string };
}

interface ConfigRouteHelpers {
  toConfigSectionValues: <T extends object>(values: T) => OpsConfigSectionValues;
  serializeTradingState: (
    state: NonNullable<OpsServerDeps['tradingStateManager']>['state']
  ) => OpsTradingStateResponse['state'];
  recordPrivilegedMutation: (action: string, details?: Record<string, unknown>) => void;
  queryPositiveInt: (request: FastifyRequest, key: string) => number | null;
  queryNonNegativeInt: (request: FastifyRequest, key: string) => number | null;
}

export interface HealthAndMetricsRouteContext {
  deps: Pick<OpsServerDeps, 'allowlist' | 'eventStore' | 'metrics' | 'opsAgent' | 'portfolioAgent'>;
  incidentsLimit: number;
  sendError: SendOpsError;
}

export interface MarketAndDebugRouteContext {
  deps: Pick<
    OpsServerDeps,
    | 'allowlist'
    | 'clobClient'
    | 'debugMarketDataOutlier'
    | 'learningAgent'
    | 'metrics'
    | 'portfolioAgent'
    | 'syntheticOpportunity'
  >;
  recordPrivilegedMutation: (action: string, details?: Record<string, unknown>) => void;
  sendError: SendOpsError;
}

export interface DecisionAndConfigRouteContext extends ConfigRouteHelpers {
  deps: Pick<
    OpsServerDeps,
    | 'applyConfigUpdate'
    | 'applyRiskProfile'
    | 'configStore'
    | 'eventStore'
    | 'infraConfig'
    | 'tradingEnabled'
    | 'tradingMode'
    | 'tradingStateManager'
  >;
  riskProfileStateRef: RiskProfileStateRef;
  policyUpdateSchema: UpdateSchema;
  riskUpdateSchema: UpdateSchema;
  sendError: SendOpsError;
}

export interface EventStreamRouteContext {
  metrics: OpsServerDeps['metrics'];
  streamHeartbeatMs: number;
  queryPositiveInt: (request: FastifyRequest, key: string) => number | null;
}

export interface OpsServerRouteContexts {
  healthAndMetrics: HealthAndMetricsRouteContext;
  marketAndDebug: MarketAndDebugRouteContext;
  decisionAndConfig: DecisionAndConfigRouteContext;
  eventStream: EventStreamRouteContext;
}
