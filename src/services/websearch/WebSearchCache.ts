import type { WebSearchContent, WebSearchResult } from './WebSearchClient.js';

type CacheEntry<T> = { value: T; expiresAtMs: number };

export interface WebSearchCacheConfig {
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class WebSearchCache {
  private readonly searchCache = new Map<string, CacheEntry<WebSearchResult[]>>();
  private readonly contentCache = new Map<string, CacheEntry<WebSearchContent>>();
  private readonly maxEntries: number;

  constructor(config?: WebSearchCacheConfig | number) {
    const maxEntries =
      typeof config === 'number'
        ? config
        : typeof config?.maxEntries === 'number'
          ? config.maxEntries
          : DEFAULT_MAX_ENTRIES;
    this.maxEntries = Math.max(Math.floor(maxEntries), 1);
  }

  getSearch(key: string, nowMs = Date.now()): WebSearchResult[] | null {
    const entry = this.searchCache.get(key);
    if (!entry) return null;
    if (nowMs >= entry.expiresAtMs) {
      this.searchCache.delete(key);
      return null;
    }
    return entry.value;
  }

  setSearch(key: string, value: WebSearchResult[], ttlMs: number, nowMs = Date.now()): void {
    if (ttlMs <= 0) return;
    this.searchCache.set(key, { value, expiresAtMs: nowMs + ttlMs });
    this.prune(this.searchCache, nowMs);
  }

  getContent(url: string, nowMs = Date.now()): WebSearchContent | null {
    const entry = this.contentCache.get(url);
    if (!entry) return null;
    if (nowMs >= entry.expiresAtMs) {
      this.contentCache.delete(url);
      return null;
    }
    return entry.value;
  }

  setContent(url: string, value: WebSearchContent, ttlMs: number, nowMs = Date.now()): void {
    if (ttlMs <= 0) return;
    this.contentCache.set(url, { value, expiresAtMs: nowMs + ttlMs });
    this.prune(this.contentCache, nowMs);
  }

  private prune<T>(map: Map<string, CacheEntry<T>>, nowMs: number): void {
    for (const [key, entry] of map) {
      if (nowMs >= entry.expiresAtMs) {
        map.delete(key);
      }
    }

    while (map.size > this.maxEntries) {
      const oldestKey = map.keys().next().value as string;
      map.delete(oldestKey);
    }
  }
}
