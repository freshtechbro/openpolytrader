import type { JsonRpcProvider } from 'ethers';

import { getRpcProvider, type RpcProvider } from '../config/rpc.js';

export interface PolygonRpcOptions {
  waitConfirmations: number;
  waitTimeoutMs: number;
}

export class PolygonRpc {
  constructor(
    private options: PolygonRpcOptions,
    private rpcProvider: RpcProvider = getRpcProvider()
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
