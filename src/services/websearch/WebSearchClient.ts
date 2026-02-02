export interface WebSearchQueryOptions {
  lookbackDays: number;
  maxResults: number;
  cacheTtlSeconds: number;
  domainAllowlist?: string[];
  domainDenylist?: string[];
}

export interface WebSearchResult {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
}

export interface WebSearchContent {
  url: string;
  title?: string;
  publishedAt?: string;
  text?: string;
  source?: string;
}

export interface WebSearchClient {
  search(query: string, options: WebSearchQueryOptions): Promise<WebSearchResult[]>;
  fetchContents(urls: string[], cacheTtlSeconds?: number): Promise<WebSearchContent[]>;
}
