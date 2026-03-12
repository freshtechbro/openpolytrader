import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CONFIG_SCHEMA } from '../config/schema.js';
import { isRiskProfileId, RISK_PROFILE_IDS } from '../config/riskProfile.js';
import type { RiskProfileId } from '../config/riskProfile.js';
import type {
  OpsConfigSchemaResponse,
  OpsConfigSectionUpdateResponse,
  OpsConfigSnapshot,
  OpsInfraConfigSnapshot,
  OpsRiskProfileApplyResponse,
  OpsRiskProfilesSnapshot,
  OpsTradingStateResponse
} from './contracts.js';
import { OPS_TRADING_MODES, parseTradingMode } from './contracts.js';
import type { DecisionAndConfigRouteContext } from './serverRouteContext.js';

export function registerDecisionAndConfigRoutes(
  app: FastifyInstance,
  context: DecisionAndConfigRouteContext
): void {
  registerDecisionRoutes(app, context);
  registerConfigReadRoutes(app, context);
  registerConfigMutationRoutes(app, context);
}

function registerDecisionRoutes(app: FastifyInstance, context: DecisionAndConfigRouteContext): void {
  app.get('/decisions', handleDecisionList.bind(null, context));
}

function registerConfigReadRoutes(app: FastifyInstance, context: DecisionAndConfigRouteContext): void {
  app.get('/config', handleConfigSnapshot.bind(null, context));
  app.get('/config/risk-profiles', handleRiskProfilesSnapshot.bind(null, context));
  app.get('/config/schema', handleConfigSchema);
  app.get('/config/infra', handleInfraConfigSnapshot.bind(null, context));
}

function registerConfigMutationRoutes(app: FastifyInstance, context: DecisionAndConfigRouteContext): void {
  app.patch('/config/policy', handlePolicyUpdate.bind(null, context));
  app.patch('/config/risk', handleRiskUpdate.bind(null, context));
  app.post('/config/risk-profile', handleRiskProfileApply.bind(null, context));
  app.post('/config/trading-mode', handleTradingModeUpdate.bind(null, context));
}

function handleDecisionList(
  context: DecisionAndConfigRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.eventStore) {
    return context.sendError(reply, 503, 'event_store_not_configured');
  }

  const query = request.query as Record<string, unknown> | undefined;
  const agent = typeof query?.agent === 'string' ? query.agent.trim() : '';
  const subjectId = typeof query?.subjectId === 'string' ? query.subjectId.trim() : '';
  const limit = Math.min(context.queryPositiveInt(request, 'limit') ?? 200, 1000);
  const sinceMs = context.queryNonNegativeInt(request, 'sinceMs');
  const untilMs = context.queryNonNegativeInt(request, 'untilMs');

  return context.deps.eventStore.listDecisions({
    agent: agent.length > 0 ? agent : undefined,
    subjectId: subjectId.length > 0 ? subjectId : undefined,
    sinceMs: sinceMs ?? undefined,
    untilMs: untilMs ?? undefined,
    limit
  });
}

function handleConfigSnapshot(
  context: DecisionAndConfigRouteContext,
  _request: unknown,
  reply: Parameters<DecisionAndConfigRouteContext['sendError']>[0]
) {
  const configStore = context.deps.configStore;
  if (!configStore) {
    return context.sendError(reply, 503, 'config_store_not_configured');
  }

  return buildConfigSnapshot(context, configStore.snapshot());
}

function handleRiskProfilesSnapshot(context: DecisionAndConfigRouteContext) {
  const snapshot: OpsRiskProfilesSnapshot = {
    activeProfile: context.riskProfileStateRef.current?.id ?? 'high',
    activeProfileSource: context.riskProfileStateRef.current?.source ?? 'defaults',
    availableProfiles: RISK_PROFILE_IDS
  };
  return snapshot;
}

function handleConfigSchema(): OpsConfigSchemaResponse {
  return CONFIG_SCHEMA;
}

function handleInfraConfigSnapshot(
  context: DecisionAndConfigRouteContext,
  _request: unknown,
  reply: Parameters<DecisionAndConfigRouteContext['sendError']>[0]
) {
  if (!context.deps.infraConfig) {
    return context.sendError(reply, 503, 'infra_config_not_configured');
  }
  const snapshot: OpsInfraConfigSnapshot = context.deps.infraConfig;
  return snapshot;
}

function handlePolicyUpdate(
  context: DecisionAndConfigRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const configStore = context.deps.configStore;
  if (!configStore) {
    return context.sendError(reply, 503, 'config_store_not_configured');
  }

  const parsed = context.policyUpdateSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return context.sendError(reply, 400, 'invalid_policy_update', { details: parsed.error.issues });
  }

  try {
    const updated = configStore.updatePolicy(parsed.data);
    context.deps.applyConfigUpdate?.(configStore.getPolicy(), configStore.getRisk());
    context.recordPrivilegedMutation('policy_updated', { fields: sortObjectKeys(parsed.data) });
    const response: OpsConfigSectionUpdateResponse = {
      policy: context.toConfigSectionValues(updated)
    };
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.sendError(reply, 400, 'invalid_policy_update', { message });
  }
}

function handleRiskUpdate(
  context: DecisionAndConfigRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const configStore = context.deps.configStore;
  if (!configStore) {
    return context.sendError(reply, 503, 'config_store_not_configured');
  }

  const parsed = context.riskUpdateSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return context.sendError(reply, 400, 'invalid_risk_update', { details: parsed.error.issues });
  }

  try {
    const updated = configStore.updateRisk(parsed.data);
    context.deps.applyConfigUpdate?.(configStore.getPolicy(), configStore.getRisk());
    context.recordPrivilegedMutation('risk_updated', { fields: sortObjectKeys(parsed.data) });
    const response: OpsConfigSectionUpdateResponse = {
      risk: context.toConfigSectionValues(updated)
    };
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.sendError(reply, 400, 'invalid_risk_update', { message });
  }
}

function handleRiskProfileApply(
  context: DecisionAndConfigRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const applyRiskProfile = context.deps.applyRiskProfile;
  if (!context.deps.configStore || !applyRiskProfile) {
    return context.sendError(reply, 503, 'risk_profile_not_configured');
  }

  const selection = parseRiskProfileSelection(request.body);
  if (!selection) {
    return context.sendError(reply, 400, 'invalid_profile', { details: { validProfiles: RISK_PROFILE_IDS } });
  }

  try {
    return applyRiskProfileSelection(context, applyRiskProfile, selection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.sendError(reply, 400, 'risk_profile_apply_failed', { message });
  }
}

function handleTradingModeUpdate(
  context: DecisionAndConfigRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!context.deps.tradingStateManager) {
    return context.sendError(reply, 503, 'trading_state_manager_not_configured');
  }

  const body = request.body as { mode?: string; enabled?: boolean } | undefined;
  const confirm = (request.query as { confirm?: string } | undefined)?.confirm;
  if (body?.mode !== undefined) {
    const nextMode = parseTradingMode(body.mode);
    if (!nextMode) {
      return context.sendError(reply, 400, 'invalid_mode', { details: { validModes: OPS_TRADING_MODES } });
    }
    if (nextMode === 'live' && confirm !== 'true') {
      return context.sendError(reply, 400, 'live_mode_requires_confirmation', {
        message: 'Add ?confirm=true to enable live trading'
      });
    }
    context.deps.tradingStateManager.setMode(nextMode);
  }

  if (body?.enabled !== undefined) {
    context.deps.tradingStateManager.setEnabled(Boolean(body.enabled));
  }

  const state = context.serializeTradingState(context.deps.tradingStateManager.state);
  context.recordPrivilegedMutation('trading_state_updated', { state });
  const response: OpsTradingStateResponse = { state };
  return response;
}

function sortObjectKeys(values: object): string[] {
  return Object.keys(values).sort((left, right) => left.localeCompare(right));
}

function buildConfigSnapshot(
  context: DecisionAndConfigRouteContext,
  current: NonNullable<DecisionAndConfigRouteContext['deps']['configStore']>['snapshot'] extends () => infer T ? T : never
): OpsConfigSnapshot {
  return {
    ...current,
    policy: context.toConfigSectionValues(current.policy),
    risk: context.toConfigSectionValues(current.risk),
    ...resolveRiskProfileSnapshot(context),
    ...resolveTradingStateSnapshot(context)
  };
}

function resolveRiskProfileSnapshot(context: DecisionAndConfigRouteContext) {
  return {
    riskProfile: context.riskProfileStateRef.current?.id ?? 'high',
    riskProfileSource: context.riskProfileStateRef.current?.source ?? 'defaults'
  };
}

function resolveTradingStateSnapshot(context: DecisionAndConfigRouteContext) {
  const tradingState = context.deps.tradingStateManager?.state;
  return {
    tradingMode: tradingState?.mode ?? context.deps.tradingMode,
    tradingEnabled: tradingState?.enabled ?? context.deps.tradingEnabled,
    tradingStateChangedAt: tradingState?.changedAt.toISOString(),
    tradingStateChangedBy: tradingState?.changedBy
  };
}

function parseRiskProfileSelection(body: unknown): { profile: RiskProfileId; overridePath?: string } | null {
  const payload = (body ?? {}) as { profile?: string; path?: string };
  const rawProfile =
    typeof payload.profile === 'string'
      ? payload.profile.trim().toLowerCase().replace(/-/g, '_')
      : '';
  if (!rawProfile || !isRiskProfileId(rawProfile)) {
    return null;
  }

  const rawPath = typeof payload.path === 'string' ? payload.path.trim() : '';
  return {
    profile: rawProfile,
    overridePath: rawPath.length > 0 ? rawPath : undefined
  };
}

function applyRiskProfileSelection(
  context: DecisionAndConfigRouteContext,
  applyRiskProfile: NonNullable<DecisionAndConfigRouteContext['deps']['applyRiskProfile']>,
  selection: { profile: RiskProfileId; overridePath?: string }
): OpsRiskProfileApplyResponse {
  const result = applyRiskProfile(selection.profile, selection.overridePath);
  context.riskProfileStateRef.current = result.profile;
  context.recordPrivilegedMutation('risk_profile_applied', {
    profile: result.profile.id,
    source: result.profile.source,
    persisted: result.persisted,
    overridePath: selection.overridePath ?? null
  });
  return {
    profile: result.profile,
    policy: context.toConfigSectionValues(result.policy),
    risk: context.toConfigSectionValues(result.risk),
    persisted: result.persisted
  };
}
