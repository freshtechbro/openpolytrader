const DEFAULTS = {
  opsBaseUrl: '',
  portfolioRefreshMs: 5000,
  sloRefreshMs: 30000,
  incidentsLimit: 100,
  incidentsPreviewLimit: 6,
  publicRepoUrl: 'https' + '://github.com/freshtechbro/openpolytrader'
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

function normalizeString(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const normalized = normalizeString(value, fallback);
  if (normalized === '') return '';
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export const OPS_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_OPS_BASE_URL,
  DEFAULTS.opsBaseUrl
);
export const PORTFOLIO_REFRESH_MS = parsePositiveInt(
  import.meta.env.VITE_PORTFOLIO_REFRESH_MS,
  DEFAULTS.portfolioRefreshMs
);
export const SLO_REFRESH_MS = parsePositiveInt(
  import.meta.env.VITE_SLO_REFRESH_MS,
  DEFAULTS.sloRefreshMs
);
export const INCIDENTS_LIMIT = parsePositiveInt(
  import.meta.env.VITE_INCIDENTS_LIMIT,
  DEFAULTS.incidentsLimit
);
export const INCIDENTS_PREVIEW_LIMIT = parsePositiveInt(
  import.meta.env.VITE_INCIDENTS_PREVIEW_LIMIT,
  DEFAULTS.incidentsPreviewLimit
);
export const PUBLIC_REPO_URL = normalizeString(
  import.meta.env.VITE_PUBLIC_REPO_URL,
  DEFAULTS.publicRepoUrl
);
