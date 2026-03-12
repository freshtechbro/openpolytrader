import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { EventStore } from '../../src/core/EventStore.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';

let messageBus = createMessageBus();

describe('MarketDataAgent LLM outlier detection', () => {
  const paths: string[] = [];

  beforeEach(() => {
    messageBus = createMessageBus();
  });

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });
  it('emits marketdata:outlier when LLM flags an outlier', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_MARKETDATA_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/marketdata-outlier.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.MarketDataAgent.timeoutMs
    });
    llmClient.enqueue('MarketDataAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.MarketDataAgent.model,
      outputText: JSON.stringify({ ...fixture, outlier: true, reason: 'weird spread' })
    });

    const agent = new MarketDataAgent(
      {
        tokenIds: [],
        policy: DEFAULT_TRADE_POLICY,
        messageBus,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      {} as unknown as PolymarketClob,
      {} as unknown as PolymarketRealtime
    );

    const outlierPromise = new Promise((resolve) =>
      messageBus.once('marketdata:outlier', (payload) => resolve(payload))
    );

    const book = {
      bestBid: { price: 0.4, size: 10 },
      bestAsk: { price: 0.8, size: 10 },
      exchangeTimestamp: 't'
    } as unknown as OrderBookState;

    await (agent as unknown as { maybeDetectOutlier: (tokenId: string, book: OrderBookState, nowMs: number) => Promise<void> }).maybeDetectOutlier(
      'token-1',
      book,
      Date.now()
    );

    const payload = await outlierPromise;
    expect(payload).toMatchObject({ tokenId: 'token-1' });
  });

  it('logs a decision when output text is missing', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_MARKETDATA_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.MarketDataAgent.timeoutMs
    });
    llmClient.enqueue('MarketDataAgent', {
      status: 'error',
      endpoint: 'chat.completions',
      model: llmConfig.agents.MarketDataAgent.model,
      outputText: null
    });

    const agent = new MarketDataAgent(
      {
        tokenIds: [],
        policy: DEFAULT_TRADE_POLICY,
        messageBus,
        eventStore: store,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      {} as unknown as PolymarketClob,
      {} as unknown as PolymarketRealtime
    );

    const book = {
      bestBid: { price: 0.4, size: 10 },
      bestAsk: { price: 0.8, size: 10 },
      exchangeTimestamp: 't'
    } as unknown as OrderBookState;

    await (agent as unknown as { maybeDetectOutlier: (tokenId: string, book: OrderBookState, nowMs: number) => Promise<void> }).maybeDetectOutlier(
      'token-1',
      book,
      Date.now()
    );

    const decisions = store.listDecisions({ agent: 'MarketDataAgent' });
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]?.decision as {
      output?: { error?: string };
      applied?: boolean;
      clamp?: { violations?: string[] };
    };
    expect(decision?.output).toMatchObject({ error: 'missing_output_text' });
    expect(decision?.applied).toBe(false);
    expect(decision?.clamp?.violations).toEqual(['missing_output_text']);

    store.close();
  });

  it('logs a decision when output is invalid JSON', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_MARKETDATA_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.MarketDataAgent.timeoutMs
    });
    llmClient.enqueue('MarketDataAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.MarketDataAgent.model,
      outputText: 'not-json'
    });

    const agent = new MarketDataAgent(
      {
        tokenIds: [],
        policy: DEFAULT_TRADE_POLICY,
        messageBus,
        eventStore: store,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      {} as unknown as PolymarketClob,
      {} as unknown as PolymarketRealtime
    );

    const book = {
      bestBid: { price: 0.4, size: 10 },
      bestAsk: { price: 0.8, size: 10 },
      exchangeTimestamp: 't'
    } as unknown as OrderBookState;

    await (agent as unknown as { maybeDetectOutlier: (tokenId: string, book: OrderBookState, nowMs: number) => Promise<void> }).maybeDetectOutlier(
      'token-1',
      book,
      Date.now()
    );

    const decisions = store.listDecisions({ agent: 'MarketDataAgent' });
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]?.decision as {
      output?: { error?: string };
      applied?: boolean;
      clamp?: { violations?: string[] };
    };
    expect(decision?.output).toMatchObject({ error: 'invalid_output' });
    expect(decision?.applied).toBe(false);
    expect(decision?.clamp?.violations).toEqual(['invalid_output']);

    store.close();
  });
});
