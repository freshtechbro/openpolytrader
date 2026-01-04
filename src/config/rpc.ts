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

/**
 * Phase 1 Configuration - $1000 Capital
 * Cost: $39/month (Alchemy Growth Plan)
 */
export const RPC_CONFIG_PHASE_1: RpcConfig = {
  phase: 1,
  primary: {
    name: 'Alchemy',
    url: 'https://polygon-mainnet.g.alchemy.com/v2',
    apiKey: process.env.ALCHEMY_API_KEY,
    rps: 125,
    priority: 1,
    wsUrl: 'wss://polygon-mainnet.g.alchemy.com/v2'
  },
  fallbacks: [
    {
      name: 'QuickNode',
      url: 'https://polygon-mainnet.g.alchemy.com/v2/demo',
      rps: 10,
      priority: 2
    },
    {
      name: 'Ankr',
      url: 'https://rpc.ankr.com/polygon',
      rps: 30,
      priority: 3
    }
  ],
  websocket: {
    name: 'Alchemy WebSocket',
    url: 'wss://polygon-mainnet.g.alchemy.com/v2',
    apiKey: process.env.ALCHEMY_API_KEY,
    rps: 125,
    priority: 1
  },
  circuitBreaker: {
    failureThreshold: 5,
    timeout: 60000,  // 60 seconds
    halfOpenRequests: 3
  }
};

/**
 * Phase 2 Configuration - $2000+ Capital
 * Cost: ~$229/month (Chainstack Pro + Ankr PAYG)
 */
export const RPC_CONFIG_PHASE_2: RpcConfig = {
  phase: 2,
  primary: {
    name: 'Chainstack Pro',
    url: process.env.CHAINSTACK_RPC_URL || 'https://polygon-mainnet.chainstacklabs.com',
    rps: 600,
    priority: 1
  },
  fallbacks: [
    {
      name: 'Alchemy Growth',
      url: 'https://polygon-mainnet.g.alchemy.com/v2',
      apiKey: process.env.ALCHEMY_API_KEY,
      rps: 125,
      priority: 2
    },
    {
      name: 'Ankr',
      url: process.env.ANKR_RPC_URL || 'https://rpc.ankr.com/polygon',
      rps: 1500,
      priority: 3
    }
  ],
  websocket: {
    name: 'Chainstack WebSocket',
    url: process.env.CHAINSTACK_WS_URL || 'wss://polygon-mainnet.chainstacklabs.com',
    rps: 600,
    priority: 1
  },
  circuitBreaker: {
    failureThreshold: 3,
    timeout: 30000,  // 30 seconds
    halfOpenRequests: 5
  }
};

/**
 * Phase 3 Configuration - $5000+ Capital
 * Cost: $500+/month (Private node + Flashbots)
 */
export const RPC_CONFIG_PHASE_3: RpcConfig = {
  phase: 3,
  primary: {
    name: 'Private Node',
    url: process.env.PRIVATE_RPC_URL || 'http://localhost:8545',
    rps: 10000,
    priority: 1
  },
  fallbacks: [
    {
      name: 'Chainstack Pro',
      url: process.env.CHAINSTACK_RPC_URL || 'https://polygon-mainnet.chainstacklabs.com',
      rps: 600,
      priority: 2
    }
  ],
  websocket: {
    name: 'Private Node WebSocket',
    url: process.env.PRIVATE_WS_URL || 'ws://localhost:8545',
    rps: 10000,
    priority: 1
  },
  circuitBreaker: {
    failureThreshold: 2,
    timeout: 15000,  // 15 seconds
    halfOpenRequests: 10
  }
};

/**
 * Auto-select configuration based on capital
 */
export function getRpcConfig(capital: number): RpcConfig {
  if (capital >= 5000) {
    return RPC_CONFIG_PHASE_3;
  } else if (capital >= 2000) {
    return RPC_CONFIG_PHASE_2;
  } else {
    return RPC_CONFIG_PHASE_1;
  }
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
    const url = config.apiKey ? `${config.url}/${config.apiKey}` : config.url;
    const provider = new ethers.JsonRpcProvider(url);
    const circuitBreaker = new CircuitBreaker(this.config.circuitBreaker, config.name);
    const rateLimiter = new RateLimiter(config.rps);

    this.providers.set(config.name, { provider, circuitBreaker });
    this.rateLimiters.set(config.name, rateLimiter);

    console.log(`[RpcProvider] Initialized ${config.name} (${url})`);
  }

  /**
   * Execute RPC call with automatic fallback
   */
  async execute<T>(method: string, params?: any[]): Promise<T> {
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
      ? `${this.config.websocket.url}/${this.config.websocket.apiKey}`
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
  getHealthStatus() {
    const status: any = {};

    for (const [name, entry] of this.providers.entries()) {
      status[name] = {
        state: entry.circuitBreaker.getState(),
        failures: entry.circuitBreaker['failures'] || 0,
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
  private lastRequestTime = 0;
  private requestTimes: number[] = [];

  constructor(private rps: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    
    // Remove requests older than 1 second
    this.requestTimes = this.requestTimes.filter(t => now - t < 1000);

    if (this.requestTimes.length >= this.rps) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = 1000 - (now - oldestRequest);
      
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimes.push(now);
  }
}

/**
 * Create RPC provider for given capital
 */
export function createRpcProvider(capital: number = 1000): RpcProvider {
  const config = getRpcConfig(capital);
  return new RpcProvider(config);
}

/**
 * Singleton instance (useful for application-wide access)
 */
let rpcProviderInstance: RpcProvider | null = null;

export function getRpcProvider(): RpcProvider {
  if (!rpcProviderInstance) {
    const capital = parseInt(process.env.TOTAL_CAPITAL || '1000');
    rpcProviderInstance = createRpcProvider(capital);
  }
  return rpcProviderInstance;
}

export function resetRpcProvider(): void {
  rpcProviderInstance = null;
}
