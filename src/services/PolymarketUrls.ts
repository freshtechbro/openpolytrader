import { buildBaseUrl, resolveBaseUrl } from '../utils/baseUrl.js';

const DEFAULT_POLYMARKET_CLOB_HOST = 'clob.polymarket.com';
const DEFAULT_POLYMARKET_DATA_API_HOST = 'data-api.polymarket.com';
const DEFAULT_POLYMARKET_CLOB_BASE_URL = buildBaseUrl('https:', DEFAULT_POLYMARKET_CLOB_HOST);
const DEFAULT_POLYMARKET_DATA_API_BASE_URL = buildBaseUrl('https:', DEFAULT_POLYMARKET_DATA_API_HOST);

export function resolvePolymarketClobBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_POLYMARKET_CLOB_BASE_URL, baseUrl);
}

export function resolvePolymarketDataApiBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_POLYMARKET_DATA_API_BASE_URL, baseUrl);
}
