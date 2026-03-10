import { buildBaseUrl, resolveBaseUrl } from '../../utils/baseUrl.js';

const DEFAULT_EXA_HOST = 'api.exa.ai';
const DEFAULT_FIRECRAWL_HOST = 'api.firecrawl.dev';
const DEFAULT_EXA_BASE_URL = buildBaseUrl('https:', DEFAULT_EXA_HOST);
const DEFAULT_FIRECRAWL_BASE_URL = buildBaseUrl('https:', DEFAULT_FIRECRAWL_HOST);

export function resolveExaBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_EXA_BASE_URL, baseUrl);
}

export function resolveFirecrawlBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_FIRECRAWL_BASE_URL, baseUrl);
}
