import { buildBaseUrl, resolveBaseUrl } from '../../utils/baseUrl.js';

const DEFAULT_EXA_HOST = 'api.exa.ai';
const DEFAULT_SERPER_HOST = 'google.serper.dev';
const DEFAULT_FIRECRAWL_HOST = 'api.firecrawl.dev';
const DEFAULT_GDELT_HOST = 'api.gdeltproject.org';
const DEFAULT_EXA_BASE_URL = buildBaseUrl('https:', DEFAULT_EXA_HOST);
const DEFAULT_SERPER_BASE_URL = buildBaseUrl('https:', DEFAULT_SERPER_HOST);
const DEFAULT_FIRECRAWL_BASE_URL = buildBaseUrl('https:', DEFAULT_FIRECRAWL_HOST);
const DEFAULT_GDELT_BASE_URL = new URL('/api/v2/doc/doc', buildBaseUrl('https:', DEFAULT_GDELT_HOST)).toString();

export function resolveExaBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_EXA_BASE_URL, baseUrl);
}

export function resolveSerperBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_SERPER_BASE_URL, baseUrl);
}

export function resolveFirecrawlBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_FIRECRAWL_BASE_URL, baseUrl);
}

export function resolveGdeltBaseUrl(baseUrl?: string): string {
  return resolveBaseUrl(DEFAULT_GDELT_BASE_URL, baseUrl);
}
