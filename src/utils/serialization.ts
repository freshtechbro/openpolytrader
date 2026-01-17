export function safeParseJSON(value: string | null | undefined): unknown {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  const fenced = extractFencedBlock(trimmed);
  if (fenced) {
    const parsed = tryParse(fenced);
    if (parsed !== null) return parsed;
  }

  const extracted = extractJsonSubstring(trimmed);
  if (extracted) {
    const parsed = tryParse(extracted);
    if (parsed !== null) return parsed;
  }

  return null;
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFencedBlock(text: string): string | null {
  const fenceStart = text.indexOf('```');
  if (fenceStart < 0) return null;
  const fenceEnd = text.indexOf('```', fenceStart + 3);
  if (fenceEnd < 0) return null;

  const firstLineEnd = text.indexOf('\n', fenceStart + 3);
  if (firstLineEnd < 0 || firstLineEnd > fenceEnd) {
    return text.slice(fenceStart + 3, fenceEnd).trim();
  }

  // Skip optional language tag line (```json)
  return text.slice(firstLineEnd + 1, fenceEnd).trim();
}

function extractJsonSubstring(text: string): string | null {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const startCandidates = [objectStart, arrayStart].filter((idx) => idx >= 0);
  if (startCandidates.length === 0) return null;

  const start = Math.min(...startCandidates);
  const endChar = text[start] === '{' ? '}' : ']';
  const end = text.lastIndexOf(endChar);
  if (end < 0 || end <= start) return null;

  return text.slice(start, end + 1).trim();
}
