export function clamp(value: number, min: number, max: number, fallback?: number): number {
  const minFinite = Number.isFinite(min) ? min : 0;
  const maxFinite = Number.isFinite(max) ? max : minFinite;
  const lo = Math.min(minFinite, maxFinite);
  const hi = Math.max(minFinite, maxFinite);
  const fallbackValue = typeof fallback === 'number' ? fallback : hi;
  const boundedFallback = Number.isFinite(fallbackValue) ? Math.min(hi, Math.max(lo, fallbackValue)) : hi;

  if (!Number.isFinite(value)) return boundedFallback;
  return Math.min(hi, Math.max(lo, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1, 0);
}
