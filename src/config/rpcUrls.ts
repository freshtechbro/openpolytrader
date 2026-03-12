import { buildBaseUrl, resolveBaseUrl } from '../utils/baseUrl.js';

function resolveRpcUrl(defaultBaseUrl: string, url?: string): string {
  return resolveBaseUrl(defaultBaseUrl, url);
}

export function resolveAlchemyRpcBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('https:', 'polygon-mainnet.g.alchemy.com', '/v2'), url);
}

export function resolveAlchemyWsBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('wss:', 'polygon-mainnet.g.alchemy.com', '/v2'), url);
}

export function resolveChainstackRpcBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('https:', 'polygon-mainnet.chainstacklabs.com'), url);
}

export function resolveChainstackWsBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('wss:', 'polygon-mainnet.chainstacklabs.com'), url);
}

export function resolveAnkrRpcBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('https:', 'rpc.ankr.com', '/polygon'), url);
}

export function resolvePrivateRpcBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('http:', 'localhost:8545'), url);
}

export function resolvePrivateWsBaseUrl(url?: string): string {
  return resolveRpcUrl(buildBaseUrl('ws:', 'localhost:8545'), url);
}
