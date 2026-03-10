import { afterEach, describe, expect, it, vi } from 'vitest';

import { LearningAgent } from '../../src/agents/learning/LearningAgent.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { loadEnv } from '../../src/config/env.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { createRuntimeSupportActors } from '../../src/boot/runtimeStartup.js';

function createStoreStub() {
  return {
    append: vi.fn(),
    getLatestEventByType: vi.fn(() => null),
    listEventsByTypes: vi.fn(() => [])
  } as unknown as Parameters<typeof createRuntimeSupportActors>[0]['store'];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRuntimeSupportActors', () => {
  it('builds the runtime support actors and token mapping directly', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const messageBus = createMessageBus();
    const metrics = new MetricsStore(32);
    const allowlist = new MarketAllowlist({ autoResume: env.ALLOWLIST_AUTO_RESUME });
    const llmBootstrap = {
      llmConfig: { enabled: false },
      llmFacade: undefined
    } as Parameters<typeof createRuntimeSupportActors>[0]['llmBootstrap'];

    const actors = createRuntimeSupportActors({
      env,
      riskConfig: DEFAULT_RISK_CONFIG,
      messageBus,
      metrics,
      store: createStoreStub(),
      allowlist,
      marketPairs: [
        {
          marketId: 'market-1',
          yesTokenId: 'yes-1',
          noTokenId: 'no-1',
          question: 'Will it rain?'
        }
      ],
      llmBootstrap
    });

    try {
      expect(actors.opsAgent).toBeDefined();
      expect(actors.incidentTracker).toBeDefined();
      expect(actors.portfolio.snapshot()).toMatchObject({
        totalCapital: env.TOTAL_CAPITAL
      });

      actors.portfolio.applyFill({ tokenId: 'yes-2', side: 'BUY', size: 1, price: 0.5 });
      actors.updateTokenToMarketId([
        { marketId: 'market-2', yesTokenId: 'yes-2', noTokenId: 'no-2', question: 'Will it snow?' }
      ]);
      messageBus.emit('ops:alert', {
        check: 'book_freshness',
        result: { ok: false, info: 'worst=yes-2 stalenessMs=1234' },
        timestamp: Date.now()
      });

      const positions = (
        actors.portfolio as unknown as {
          positions: Map<string, { marketId?: string }>;
        }
      ).positions;
      expect(positions.get('yes-2')?.marketId).toBe('market-2');
    } finally {
      actors.opsAgent.stop();
      expect(actors.learning).toBeInstanceOf(LearningAgent);
    }
  });

  it('covers the LLM-enabled support path and ignores malformed ops alerts', () => {
    vi.useFakeTimers();

    const env = loadEnv({
      NODE_ENV: 'development',
      OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS: '45000'
    });
    const messageBus = createMessageBus();
    const metrics = new MetricsStore(32);
    const allowlist = new MarketAllowlist({ autoResume: env.ALLOWLIST_AUTO_RESUME });
    const llmBootstrap = {
      llmConfig: { enabled: true },
      llmFacade: {
        config: {
          enabled: true,
          agents: {
            LearningAgent: { mode: 'disabled', model: 'mock-learning' }
          }
        }
      }
    } as unknown as Parameters<typeof createRuntimeSupportActors>[0]['llmBootstrap'];

    const actors = createRuntimeSupportActors({
      env,
      riskConfig: DEFAULT_RISK_CONFIG,
      messageBus,
      metrics,
      store: createStoreStub(),
      allowlist,
      marketPairs: [
        {
          marketId: 'market-llm',
          yesTokenId: 'yes-llm',
          noTokenId: 'no-llm',
          question: 'Will the LLM path stay covered?'
        }
      ],
      llmBootstrap
    });

    try {
      messageBus.emit('ops:alert', {
        check: 'book_freshness',
        result: { ok: false, info: 42 },
        timestamp: Date.now()
      } as never);
      messageBus.emit('ops:alert', {
        check: 'book_freshness',
        result: { ok: false, info: 'worst=yes-llm stalenessMs=1234' },
        timestamp: Date.now()
      });

      expect(metrics.recent('incident', 10)).toHaveLength(0);
      expect(actors.learning).toBeInstanceOf(LearningAgent);
    } finally {
      actors.learning.stop();
      actors.opsAgent.stop();
    }
  });
});
