import type { CircuitBreakerConfig } from '../core/CircuitBreaker.js';
import type { Env } from './env.js';
import {
  resolveAlchemyRpcBaseUrl,
  resolveAlchemyWsBaseUrl,
  resolveAnkrRpcBaseUrl,
  resolveChainstackRpcBaseUrl,
  resolveChainstackWsBaseUrl,
  resolvePrivateRpcBaseUrl,
  resolvePrivateWsBaseUrl
} from './rpcUrls.js';

export interface RpcProviderConfig {
  name: string;
  url: string;
  apiKey?: string;
  rps: number;
  priority: number;
  wsUrl?: string;
  rateLimitWindowMs: number;
}

export interface RpcConfig {
  phase: 1 | 2 | 3;
  primary: RpcProviderConfig;
  fallbacks: RpcProviderConfig[];
  websocket: RpcProviderConfig | null;
  circuitBreaker: CircuitBreakerConfig;
}

function normalizeUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildCircuitBreaker(env: Env, phase: 1 | 2 | 3): RpcConfig['circuitBreaker'] {
  if (phase === 1) {
    return {
      failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE1,
      cooldownMs: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE1,
      halfOpenSuccesses: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE1
    };
  }
  if (phase === 2) {
    return {
      failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE2,
      cooldownMs: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE2,
      halfOpenSuccesses: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE2
    };
  }
  return {
    failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3,
    cooldownMs: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE3,
    halfOpenSuccesses: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE3
  };
}

function buildPhase1Config(env: Env): RpcConfig {
  const rateLimitWindowMs = env.RPC_RATE_LIMIT_WINDOW_MS;
  const fallbacks: RpcProviderConfig[] = [];
  let priority = 2;

  const quicknodeUrl = normalizeUrl(env.QUICKNODE_RPC_URL);
  if (quicknodeUrl) {
    fallbacks.push({
      name: 'QuickNode',
      url: quicknodeUrl,
      rps: env.QUICKNODE_RPC_RPS,
      priority: priority++,
      rateLimitWindowMs
    });
  }

  const ankrUrl = normalizeUrl(env.ANKR_RPC_URL) ?? resolveAnkrRpcBaseUrl(env.ANKR_RPC_URL);
  if (ankrUrl) {
    fallbacks.push({
      name: 'Ankr',
      url: ankrUrl,
      rps: env.ANKR_RPC_RPS_PHASE1,
      priority: priority++,
      rateLimitWindowMs
    });
  }

  return {
    phase: 1,
    primary: {
      name: 'Alchemy',
      url: resolveAlchemyRpcBaseUrl(env.ALCHEMY_RPC_URL),
      apiKey: env.ALCHEMY_API_KEY,
      rps: env.ALCHEMY_RPC_RPS,
      priority: 1,
      wsUrl: resolveAlchemyWsBaseUrl(env.ALCHEMY_WS_URL),
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Alchemy WebSocket',
      url: resolveAlchemyWsBaseUrl(env.ALCHEMY_WS_URL),
      apiKey: env.ALCHEMY_API_KEY,
      rps: env.ALCHEMY_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    circuitBreaker: buildCircuitBreaker(env, 1)
  };
}

function buildPhase2Config(env: Env): RpcConfig {
  const rateLimitWindowMs = env.RPC_RATE_LIMIT_WINDOW_MS;
  const fallbacks: RpcProviderConfig[] = [];
  let priority = 2;

  const alchemyUrl = normalizeUrl(env.ALCHEMY_RPC_URL) ?? resolveAlchemyRpcBaseUrl(env.ALCHEMY_RPC_URL);
  if (alchemyUrl) {
    fallbacks.push({
      name: 'Alchemy Growth',
      url: alchemyUrl,
      apiKey: env.ALCHEMY_API_KEY,
      rps: env.ALCHEMY_RPC_RPS,
      priority: priority++,
      rateLimitWindowMs
    });
  }

  const ankrUrl = normalizeUrl(env.ANKR_RPC_URL) ?? resolveAnkrRpcBaseUrl(env.ANKR_RPC_URL);
  if (ankrUrl) {
    fallbacks.push({
      name: 'Ankr',
      url: ankrUrl,
      rps: env.ANKR_RPC_RPS_PHASE2,
      priority: priority++,
      rateLimitWindowMs
    });
  }

  return {
    phase: 2,
    primary: {
      name: 'Chainstack Pro',
      url: resolveChainstackRpcBaseUrl(env.CHAINSTACK_RPC_URL),
      rps: env.CHAINSTACK_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Chainstack WebSocket',
      url: resolveChainstackWsBaseUrl(env.CHAINSTACK_WS_URL),
      rps: env.CHAINSTACK_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    circuitBreaker: buildCircuitBreaker(env, 2)
  };
}

function buildPhase3Config(env: Env): RpcConfig {
  const rateLimitWindowMs = env.RPC_RATE_LIMIT_WINDOW_MS;
  const fallbacks: RpcProviderConfig[] = [];
  let priority = 2;

  const chainstackUrl = normalizeUrl(env.CHAINSTACK_RPC_URL) ?? resolveChainstackRpcBaseUrl(env.CHAINSTACK_RPC_URL);
  if (chainstackUrl) {
    fallbacks.push({
      name: 'Chainstack Pro',
      url: chainstackUrl,
      rps: env.CHAINSTACK_RPC_RPS,
      priority: priority++,
      rateLimitWindowMs
    });
  }

  return {
    phase: 3,
    primary: {
      name: 'Private Node',
      url: resolvePrivateRpcBaseUrl(env.PRIVATE_RPC_URL),
      rps: env.PRIVATE_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Private Node WebSocket',
      url: resolvePrivateWsBaseUrl(env.PRIVATE_WS_URL),
      rps: env.PRIVATE_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    circuitBreaker: buildCircuitBreaker(env, 3)
  };
}

export function getRpcConfig(env: Env, capital: number): RpcConfig {
  if (capital >= 5000) {
    return buildPhase3Config(env);
  }
  if (capital >= 2000) {
    return buildPhase2Config(env);
  }
  return buildPhase1Config(env);
}
