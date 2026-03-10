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

import { CircuitBreaker } from '../core/CircuitBreaker.js';
import { RateLimiter } from '../services/RateLimiter.js';
import type { Env } from './env.js';
import { getRpcConfig, type RpcConfig, type RpcProviderConfig } from './rpcConfig.js';

function writeRpcWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function writeRpcInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

function joinUrlPath(base: string, suffix: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${left}/${right}`;
}

function createSharedCircuitBreaker(config: RpcConfig['circuitBreaker'], serviceName: string): CircuitBreaker {
  return new CircuitBreaker(config, serviceName);
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
    const circuitBreaker = createSharedCircuitBreaker(this.config.circuitBreaker, config.name);
    const rateLimiter = new RateLimiter(config.rps, config.rateLimitWindowMs);

    this.providers.set(config.name, { provider, circuitBreaker });
    this.rateLimiters.set(config.name, rateLimiter);

    console.log(`RPC provider initialized: ${config.name} (${url})`);
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
      writeRpcWarning(`RPC provider error on ${this.currentProviderName}: ${message}`);
      const currentProviderName = this.currentProviderName;

      // Try fallback providers
      for (const [name, entry] of this.providers.entries()) {
        if (
          name !== currentProviderName &&
          entry.circuitBreaker.refreshAndGetState() !== 'open'
        ) {
          try {
            await this.rateLimiters.get(name)!.acquire();
            const result = await entry.circuitBreaker.execute(async () => {
              return (await entry.provider.send(method, params ?? [])) as Promise<T>;
            });
            writeRpcInfo(`RPC provider falling back to ${name}`);
            this.currentProviderName = name;
            return result;
          } catch (fallbackError) {
            const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            writeRpcWarning(`RPC provider fallback ${name} also failed: ${message}`);
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

    writeRpcInfo(`RPC provider switched to ${providerName}`);
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
        state: entry.circuitBreaker.refreshAndGetState(),
        failures: entry.circuitBreaker.getFailureCount(),
        isCurrent: name === this.currentProviderName
      };
    }

    return status;
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
