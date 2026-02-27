export function projectToSimplex(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [1];

  const sorted = values
    .map((value, index) => ({ value: finite(value), index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);

  let cumulative = 0;
  let rho = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    cumulative += sorted[i].value;
    const threshold = (cumulative - 1) / (i + 1);
    if (sorted[i].value - threshold > 0) {
      rho = i + 1;
    }
  }

  const theta =
    (sorted.slice(0, rho).reduce((sum, item) => sum + item.value, 0) - 1) / Math.max(rho, 1);

  const projected = values.map((value) => Math.max(0, finite(value) - theta));
  const sum = projected.reduce((total, value) => total + value, 0);
  if (sum <= 0) {
    return Array.from({ length: values.length }, () => 1 / values.length);
  }
  return projected.map((value) => value / sum);
}

export function clipUnitInterval(values: number[]): number[] {
  return values.map((value) => Math.max(0, Math.min(1, finite(value))));
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}
