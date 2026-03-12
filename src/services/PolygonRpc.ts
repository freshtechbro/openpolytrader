import type { JsonRpcProvider } from 'ethers';

import type { Env } from '../config/env.js';
import { createRpcProvider, RpcProvider } from '../config/rpc.js';

interface PolygonRpcOptions {
  waitConfirmations: number;
  waitTimeoutMs: number;
}

export class PolygonRpc {
  static fromEnv(env: Env, options: PolygonRpcOptions, capital?: number): PolygonRpc {
    return new PolygonRpc(options, createRpcProvider(env, capital));
  }

  constructor(
    private options: PolygonRpcOptions,
    private rpcProvider: RpcProvider
  ) {}

  async send<T>(method: string, params?: unknown[]): Promise<T> {
    return this.rpcProvider.execute<T>(method, params);
  }

  getProvider(): JsonRpcProvider {
    return this.rpcProvider.getProvider();
  }

  async waitForTransaction(
    txHash: string,
    confirmations?: number,
    timeoutMs?: number
  ) {
    const resolvedConfirmations = confirmations ?? this.options.waitConfirmations;
    const resolvedTimeoutMs = timeoutMs ?? this.options.waitTimeoutMs;
    return this.getProvider().waitForTransaction(txHash, resolvedConfirmations, resolvedTimeoutMs);
  }
}
