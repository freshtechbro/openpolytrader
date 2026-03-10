export function normalizeBaseUrlOverride(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

export function buildBaseUrl(protocol: string, host: string, path = '/'): string {
  const origin = `${protocol}//${host}`;
  return new URL(path, origin).toString().replace(/\/$/, '');
}

export function resolveBaseUrl(defaultBaseUrl: string, override?: string): string {
  return normalizeBaseUrlOverride(override) ?? defaultBaseUrl;
}
