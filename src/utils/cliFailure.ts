function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writeCliFailure(prefix: string, error: unknown): void {
  process.stderr.write(`${prefix}: ${errorMessage(error)}\n`);
}

export function writeCliFailureDetail(prefix: string, detail: unknown): void {
  const value =
    typeof detail === 'string'
      ? detail
      : JSON.stringify(detail, null, 2);
  process.stderr.write(`${prefix}: ${value}\n`);
}
