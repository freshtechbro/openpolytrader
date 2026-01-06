/**
 * RPC Configuration with Provider Selection and Fallback Logic
 * 
 * This module manages RPC provider selection, fallback mechanisms,
 * and rate limiting for Polygon network interactions.
 * 
 * Phase 1 Configuration ($1000 capital):
 * - Primary: Alchemy Growth Plan ($39/mo, 125 RPS, 75M CUs)
 * - Fallback: QuickNode Public (10 RPS)
 * 
 * Upgrade Path:
 * - Phase 2 ($2000+): Chainstack Pro + Ankr PAYG
 * - Phase 3 ($5000+): Private node + Flashbots
 */

import { ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';
import { loadEnv, type Env } from './env.js';

/**
 * RPC Provider Configuration
 */
export interface RpcProviderConfig {
  name: string;
  url: string;
  apiKey?: string;
  rps: number;           // Rate limit per second
  priority: number;       // Lower = higher priority
  wsUrl?: string;         // WebSocket URL (optional)
  rateLimitWindowMs: number;
}

/**
 * RPC Configuration for Different Phases
 */
export interface RpcConfig {
  phase: 1 | 2 | 3;
  primary: RpcProviderConfig;
  fallbacks: RpcProviderConfig[];
  websocket: RpcProviderConfig | null;
  circuitBreaker: {
    failureThreshold: number;
    timeout: number;
    halfOpenRequests: number;
  };
}

function normalizeUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function joinUrlPath(base: string, suffix: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${left}/${right}`;
}

function buildCircuitBreaker(env: Env, phase: 1 | 2 | 3): RpcConfig['circuitBreaker'] {
  if (phase === 1) {
    return {
      failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE1,
      timeout: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE1,
      halfOpenRequests: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE1
    };
  }
  if (phase === 2) {
    return {
      failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE2,
      timeout: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE2,
      halfOpenRequests: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE2
    };
  }
  return {
    failureThreshold: env.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3,
    timeout: env.RPC_CIRCUIT_TIMEOUT_MS_PHASE3,
    halfOpenRequests: env.RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE3
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

  const ankrUrl = normalizeUrl(env.ANKR_RPC_URL);
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
      url: env.ALCHEMY_RPC_URL,
      apiKey: env.ALCHEMY_API_KEY,
      rps: env.ALCHEMY_RPC_RPS,
      priority: 1,
      wsUrl: env.ALCHEMY_WS_URL,
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Alchemy WebSocket',
      url: env.ALCHEMY_WS_URL,
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

  const alchemyUrl = normalizeUrl(env.ALCHEMY_RPC_URL);
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

  const ankrUrl = normalizeUrl(env.ANKR_RPC_URL);
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
      url: env.CHAINSTACK_RPC_URL,
      rps: env.CHAINSTACK_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Chainstack WebSocket',
      url: env.CHAINSTACK_WS_URL,
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

  const chainstackUrl = normalizeUrl(env.CHAINSTACK_RPC_URL);
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
      url: env.PRIVATE_RPC_URL,
      rps: env.PRIVATE_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    fallbacks,
    websocket: {
      name: 'Private Node WebSocket',
      url: env.PRIVATE_WS_URL,
      rps: env.PRIVATE_RPC_RPS,
      priority: 1,
      rateLimitWindowMs
    },
    circuitBreaker: buildCircuitBreaker(env, 3)
  };
}

/**
 * Auto-select configuration based on capital
 */
export function getRpcConfig(env: Env, capital: number): RpcConfig {
  if (capital >= 5000) {
    return buildPhase3Config(env);
  }
  if (capital >= 2000) {
    return buildPhase2Config(env);
  }
  return buildPhase1Config(env);
}

/**
 * Circuit Breaker State
 */
type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private successesInHalfOpen = 0;

  constructor(private config: RpcConfig['circuitBreaker'], private serviceName: string) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      
      if (timeSinceLastFailure < this.config.timeout) {
        throw new Error(`Circuit breaker is open for ${this.serviceName}`);
      } else {
        console.log(`[CircuitBreaker] Moving to half-open for ${this.serviceName}`);
        this.state = 'half-open';
        this.successesInHalfOpen = 0;
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;

    if (this.state === 'half-open') {
      this.successesInHalfOpen++;
      
      if (this.successesInHalfOpen >= this.config.halfOpenRequests) {
        console.log(`[CircuitBreaker] Closing circuit for ${this.serviceName}`);
        this.state = 'closed';
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.failureThreshold) {
      console.error(`[CircuitBreaker] Opening circuit for ${this.serviceName} (${this.failures} failures)`);
      this.state = 'open';
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failures;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
    this.successesInHalfOpen = 0;
  }
}

/**
 * RPC Provider with Automatic Fallback
 */
export class RpcProvider {
  private providers: Map<string, { provider: JsonRpcProvider; circuitBreaker: CircuitBreaker }>;
  private currentProviderName: string;
  private config: RpcConfig;
  private rateLimiters: Map<string, RateLimiter>;

  constructor(config: RpcConfig) {
    this.config = config;
    this.providers = new Map();
    this.rateLimiters = new Map();
    this.currentProviderName = config.primary.name;

    // Initialize providers
    this.initializeProvider(config.primary);
    config.fallbacks.forEach(fallback => this.initializeProvider(fallback));
  }

  private initializeProvider(config: RpcProviderConfig): void {
    const url = config.apiKey ? joinUrlPath(config.url, config.apiKey) : config.url;
    const provider = new ethers.JsonRpcProvider(url);
    const circuitBreaker = new CircuitBreaker(this.config.circuitBreaker, config.name);
    const rateLimiter = new RateLimiter(config.rps, config.rateLimitWindowMs);

    this.providers.set(config.name, { provider, circuitBreaker });
    this.rateLimiters.set(config.name, rateLimiter);

    console.log(`[RpcProvider] Initialized ${config.name} (${url})`);
  }

  /**
   * Execute RPC call with automatic fallback
   */
  async execute<T>(method: string, params?: unknown[]): Promise<T> {
    const providerEntry = this.getProviderEntry();

    try {
      await this.rateLimiters.get(this.currentProviderName)!.acquire();
      
      return await providerEntry.circuitBreaker.execute(async () => {
        return (await providerEntry.provider.send(method, params ?? [])) as Promise<T>;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[RpcProvider] Error on ${this.currentProviderName}:`, message);
      
      // Try fallback providers
      for (const [name, entry] of this.providers.entries()) {
        if (name !== this.currentProviderName && entry.circuitBreaker.getState() !== 'open') {
          console.log(`[RpcProvider] Falling back to ${name}`);
          this.currentProviderName = name;
          
          try {
            await this.rateLimiters.get(name)!.acquire();
            return await entry.circuitBreaker.execute(async () => {
              return (await entry.provider.send(method, params ?? [])) as Promise<T>;
            });
          } catch (fallbackError) {
            const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            console.error(`[RpcProvider] Fallback ${name} also failed:`, message);
          }
        }
      }

      throw new Error(`All RPC providers failed for ${method}`);
    }
  }

  /**
   * Get the current provider
   */
  private getProviderEntry() {
    const entry = this.providers.get(this.currentProviderName);
    if (!entry) {
      throw new Error(`Provider ${this.currentProviderName} not found`);
    }
    return entry;
  }

  /**
   * Get the raw ethers provider for direct use
   */
  getProvider(): JsonRpcProvider {
    return this.getProviderEntry().provider;
  }

  /**
   * Get WebSocket provider (if configured)
   */
  getWebSocketProvider(): WebSocketProvider | null {
    if (!this.config.websocket) {
      return null;
    }

    const url = this.config.websocket.apiKey
      ? joinUrlPath(this.config.websocket.url, this.config.websocket.apiKey)
      : this.config.websocket.url;

    return new ethers.WebSocketProvider(url);
  }

  /**
   * Switch to a specific provider
   */
  switchTo(providerName: string): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider ${providerName} not configured`);
    }

    console.log(`[RpcProvider] Switching to ${providerName}`);
    this.currentProviderName = providerName;
  }

  /**
   * Get current provider name
   */
  getCurrentProvider(): string {
    return this.currentProviderName;
  }

  /**
   * Get provider health status
   */
  getHealthStatus(): Record<string, { state: string; failures: number; isCurrent: boolean }> {
    const status: Record<string, { state: string; failures: number; isCurrent: boolean }> = {};

    for (const [name, entry] of this.providers.entries()) {
      status[name] = {
        state: entry.circuitBreaker.getState(),
        failures: entry.circuitBreaker.getFailureCount(),
        isCurrent: name === this.currentProviderName
      };
    }

    return status;
  }
}

/**
 * Simple Rate Limiter
 */
class RateLimiter {
  private requestTimes: number[] = [];

  constructor(private rps: number, private windowMs: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    
    // Remove requests outside the configured window
    this.requestTimes = this.requestTimes.filter((t) => now - t < this.windowMs);

    if (this.requestTimes.length >= this.rps) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimes.push(now);
  }
}

/**
 * Create RPC provider for given capital
 */
export function createRpcProvider(env: Env, capital?: number): RpcProvider {
  const resolvedCapital = capital ?? env.TOTAL_CAPITAL;
  const config = getRpcConfig(env, resolvedCapital);
  return new RpcProvider(config);
}

/**
 * Singleton instance (useful for application-wide access)
 */
let rpcProviderInstance: RpcProvider | null = null;

export function getRpcProvider(env: Env = loadEnv()): RpcProvider {
  if (!rpcProviderInstance) {
    rpcProviderInstance = createRpcProvider(env);
  }
  return rpcProviderInstance;
}

export function resetRpcProvider(): void {
  rpcProviderInstance = null;
}
