interface ExtractResponseTextOptions {
  fallbackToRoot?: boolean;
}

const DIRECT_TEXT_FIELDS = ['output_text', 'completion', 'text'] as const;
const RECURSIVE_TEXT_FIELDS = ['text', 'content'] as const;
const STRING_ONLY_FIELDS = ['value', 'completion', 'output_text'] as const;
const NESTED_RESPONSE_FIELDS = ['content', 'message', 'choices', 'output'] as const;

export function extractResponseText(
  value: unknown,
  options: ExtractResponseTextOptions = {}
): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const direct = coerceFirstText(record, DIRECT_TEXT_FIELDS);
  if (direct) return direct;

  const parts: string[] = [];
  for (const field of NESTED_RESPONSE_FIELDS) {
    collectTextParts(record[field], parts);
  }
  if (parts.length === 0 && options.fallbackToRoot) {
    collectTextParts(record, parts);
  }

  if (parts.length === 0) return null;
  return parts.join('\n').trim();
}

function coerceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceFirstText(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const text = coerceText(record[field]);
    if (text) return text;
  }
  return null;
}

function collectTextParts(input: unknown, parts: string[]): void {
  if (!input) return;
  if (typeof input === 'string') {
    pushText(parts, input);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      collectTextParts(item, parts);
    }
    return;
  }
  if (typeof input !== 'object') return;

  const record = input as Record<string, unknown>;
  for (const field of RECURSIVE_TEXT_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') {
      pushText(parts, value);
      continue;
    }
    if (value) {
      collectTextParts(value, parts);
    }
  }

  for (const field of STRING_ONLY_FIELDS) {
    pushText(parts, record[field]);
  }

  for (const field of ['message', 'choices', 'output'] as const) {
    if (record[field]) collectTextParts(record[field], parts);
  }
}

function pushText(parts: string[], value: unknown): void {
  const text = coerceText(value);
  if (text) {
    parts.push(text);
  }
}
