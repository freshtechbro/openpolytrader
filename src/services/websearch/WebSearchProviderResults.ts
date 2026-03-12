import type { WebSearchResult } from './WebSearchClient.js';

type SearchEntry = Record<string, unknown>;

interface SearchEntryFieldMap {
  snippet: string[];
  publishedAt?: string[];
}

export function normalizeSearchEntries(
  entries: SearchEntry[],
  fieldMap: SearchEntryFieldMap,
  extractDomain: (url: string) => string | undefined
): WebSearchResult[] {
  return entries
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      if (!url) return null;

      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const snippet = readOptionalString(entry, fieldMap.snippet);
      const publishedAt = fieldMap.publishedAt ? readOptionalString(entry, fieldMap.publishedAt) : undefined;
      const result: WebSearchResult = { url, source: extractDomain(url) };
      if (title) result.title = title;
      if (snippet) result.snippet = snippet;
      if (publishedAt) result.publishedAt = publishedAt;
      return result;
    })
    .filter((entry): entry is WebSearchResult => entry !== null);
}

function readOptionalString(entry: SearchEntry, fieldNames: string[]): string | undefined {
  for (const fieldName of fieldNames) {
    if (typeof entry[fieldName] === 'string') {
      return entry[fieldName] as string;
    }
  }
  return undefined;
}
