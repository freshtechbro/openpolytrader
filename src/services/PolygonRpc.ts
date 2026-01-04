import type { JsonRpcProvider } from 'ethers';

import { getRpcProvider, type RpcProvider } from '../config/rpc.js';

export class PolygonRpc {
  constructor(private rpcProvider: RpcProvider = getRpcProvider()) {}

  async send<T>(method: string, params?: unknown[]): Promise<T> {
    return this.rpcProvider.execute<T>(method, params as any[]);
  }

  getProvider(): JsonRpcProvider {
    return this.rpcProvider.getProvider();
  }

  async waitForTransaction(
    txHash: string,
    confirmations = 1,
    timeoutMs = 60000
  ) {
    return this.getProvider().waitForTransaction(txHash, confirmations, timeoutMs);
  }
}
