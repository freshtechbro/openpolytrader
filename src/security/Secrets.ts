export function redactSecret(value: string | undefined, visible = 4): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= visible) return '*'.repeat(trimmed.length);
  return `${'*'.repeat(Math.max(0, trimmed.length - visible))}${trimmed.slice(-visible)}`;
}

export function hasSecret(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
