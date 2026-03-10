import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OpsConfigSnapshot,
  OpsInfraConfigSnapshot,
  OpsPortfolioSnapshot,
  OpsRiskProfilesSnapshot
} from '../../src/api/contracts.js';
import type { ConfigSchema } from '../../src/config/schemaTypes.js';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isElementLike(value: unknown): value is ElementLike {
  if (!value || typeof value !== 'object') return false;
  return 'type' in value && 'props' in value;
}

function childNodes(value: unknown): unknown[] {
  if (value === undefined || value === null || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

function propNodes(props: Record<string, unknown> & { children?: unknown }): unknown[] {
  return Object.entries(props)
    .filter(([key]) => key !== 'children')
    .flatMap(([, value]) => childNodes(value));
}

function nestedNodes(node: ElementLike): unknown[] {
  const propChildren = [...childNodes(node.props.children), ...propNodes(node.props)];
  if (typeof node.type !== 'function') {
    return propChildren;
  }

  try {
    return Array.from(new Set([...propChildren, ...childNodes(node.type(node.props))]));
  } catch {
    return propChildren;
  }
}

function findAll(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike[] {
  if (!isElementLike(node)) return [];
  const matches = predicate(node) ? [node] : [];
  const nested = nestedNodes(node);
  return Array.from(new Set(nested.reduce<ElementLike[]>(
    (all, child) => all.concat(findAll(child, predicate)),
    matches
  )));
}

function findOne(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike {
  const matches = findAll(node, predicate);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isElementLike(node)) return nestedNodes(node).map(textContent).join('');
  return '';
}

function mockDashboardReact(stateValues: unknown[] = []) {
  let stateIndex = 0;
  const setters: Array<ReturnType<typeof vi.fn>> = [];

  const reactMock = {
    __esModule: true,
    default: {
      Fragment: 'fragment',
      StrictMode: 'strict-mode'
    },
    useState: vi.fn((initial: unknown) => {
      const setter = vi.fn();
      setters.push(setter);
      const value = stateIndex < stateValues.length ? stateValues[stateIndex] : initial;
      stateIndex += 1;
      return [value, setter];
    }),
    useMemo: (factory: () => unknown) => factory(),
    useCallback: <T,>(value: T) => value,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useRef: (value: unknown) => ({ current: value })
  };

  vi.doMock('react', () => reactMock);
  vi.doMock('../../dashboard/node_modules/react/index.js', () => reactMock);

  return { setters };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('react');
  vi.unmock('../../dashboard/node_modules/react/index.js');
  vi.unmock('../../dashboard/src/hooks/useEventStream');
  vi.unmock('../../dashboard/src/lib/opsClient');
});

describe('dashboard page modules', () => {
  it('renders the decisions page shell and triggers the persisted fetch', async () => {
    mockDashboardReact();
    const opsFetchJson = vi.fn(async () => []);

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: () => [{ connected: true }]
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      getOpsStreamUrl: () => '/stream',
      opsFetchJson
    }));

    const { Decisions } = await import('../../dashboard/src/pages/Decisions');
    const element = Decisions();

    expect(findOne(element, (entry) => entry.props.title === 'Decisions')).toBeDefined();
    expect(findAll(element, (entry) => entry.props.title === 'Filters')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.title === 'Recent decisions')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.title === 'Decision detail')).toHaveLength(1);
    expect(opsFetchJson).toHaveBeenCalledWith('/decisions?limit=200', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('renders the incidents page table and preview toggle', async () => {
    mockDashboardReact([false]);
    const incidents = Array.from({ length: 26 }, (_, index) => ({
      timestamp: 1_700_000_000_000 + index * 1000,
      check: `check-${index}`,
      result: { error: `error-${index}` }
    }));

    const { Incidents } = await import('../../dashboard/src/pages/Incidents');
    const element = Incidents({ incidents });

    expect(findAll(element, (entry) => entry.props.title === 'Incidents').length).toBeGreaterThanOrEqual(2);
    expect(findOne(element, (entry) => entry.props.className === 'link-button')).toBeDefined();
    expect(textContent(findOne(element, (entry) => entry.props.className === 'link-button').props.children)).toBe('Show all');
  });

  it('renders the markets page shell and kicks off a refresh fetch', async () => {
    mockDashboardReact();
    const opsFetchJson = vi.fn(async () => [
      {
        key: 'market-1',
        question: 'Will the spread hold?',
        description: 'demo',
        entry: { status: 'active', until: 1_700_000_000_000, reason: 'clear' }
      }
    ]);

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: () => [{ connected: true }]
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      getOpsStreamUrl: () => '/stream',
      opsFetchJson
    }));

    const { Markets } = await import('../../dashboard/src/pages/Markets');
    const element = Markets({
      allowlist: [
        {
          key: 'market-1',
          question: 'Will the spread hold?',
          description: 'demo',
          entry: { status: 'active', until: 1_700_000_000_000, reason: 'clear' }
        }
      ]
    });

    expect(findOne(element, (entry) => entry.props.title === 'Markets')).toBeDefined();
    expect(findAll(element, (entry) => textContent(entry.props.children) === 'Allowlist').length).toBeGreaterThan(0);
    expect(findAll(element, (entry) => entry.type === 'button').map((entry) => textContent(entry.props.children))).toContain('Refresh');
    expect(opsFetchJson).toHaveBeenCalledWith('/markets');
  });

  it('renders the overview page cards, tables, and incident toggle', async () => {
    mockDashboardReact([false, false]);

    const { Overview } = await import('../../dashboard/src/pages/Overview');
    const element = Overview({
      health: {
        status: 'healthy',
        checks: {
          feed: { ok: true, latencyMs: 12 }
        },
        uptimeMs: 3_661_000,
        lastCheckMs: Date.now()
      },
      metrics: {
        counts: {
          incident: 2,
          opportunity: 5,
          order: 3,
          fill: 1,
          fw_projection: 4,
          fw_dependency: 2,
          fw_oracle: 7,
          fw_iteration: 9,
          fw_gap: 1,
          fw_basket: 0,
          gate_rejection: 6
        },
        lastEventAt: Date.now()
      },
      slo: {
        aggregates: [
          {
            window: '1h',
            pairedFillRate: 0.91,
            p95LatencyMs: 120,
            p95AckLatencyMs: 80,
            delayedAckRate: 0.02,
            bookFreshnessViolations: 1
          }
        ]
      },
      intents: [
        {
          opportunityId: 'opp-1',
          marketQuestion: 'Will it fill?',
          strategy: 'ev',
          gatedAt: 1_700_000_000_000,
          orderStatus: 'submitted',
          orderReason: 'order_submitted'
        }
      ],
      incidents: [
        {
          timestamp: 1_700_000_000_000,
          check: 'feed',
          result: { error: 'none' }
        }
      ],
      expanded: false,
      onToggleExpanded: vi.fn()
    });

    expect(textContent(findOne(element, (entry) => entry.type === 'h1').props.children)).toContain('Control the edge');
    expect(findAll(element, (entry) => entry.props.title === 'Live Health')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.title === '1h / 24h')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.title === 'All intents (gated)')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.title === 'Executed intents')).toHaveLength(1);
    expect(findOne(element, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Show more')).toBeDefined();
  });

  it('renders the positions page summary, exposure table, and polling fetch', async () => {
    const portfolio: OpsPortfolioSnapshot = {
      totalCapital: 1500.25,
      availableCapital: 1200.5,
      dailyPnL: 45.1,
      openInventoryAgeMs: 0,
      marketExposure: {
        'This market name is definitely longer than sixteen characters': 275.44
      }
    };

    mockDashboardReact([portfolio, null, false]);
    const opsFetchJson = vi.fn(async () => portfolio);
    const setIntervalMock = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      () => 1 as unknown as ReturnType<typeof setInterval>
    );
    const clearIntervalMock = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      opsFetchJson
    }));

    const { Positions } = await import('../../dashboard/src/pages/Positions');
    const element = Positions();
    const metricsTables = findAll(
      element,
      (entry) => Array.isArray(entry.props.columns) && Array.isArray(entry.props.rows)
    );
    const summaryTable = metricsTables.find((entry) => entry.props.columns?.[0] === 'Metric');
    const exposureTable = metricsTables.find((entry) => entry.props.columns?.[0] === 'Market');

    expect(findOne(element, (entry) => entry.props.title === 'Positions')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Market Exposure')).toBeDefined();
    expect(summaryTable?.props.rows).toEqual([
      ['Total Capital', '$1500.25'],
      ['Available Capital', '$1200.50'],
      ['Daily PnL', '$45.10']
    ]);
    expect(exposureTable?.props.rows).toEqual([['This market name...', '$275.44']]);
    expect(opsFetchJson).toHaveBeenCalledWith('/portfolio');
    expect(setIntervalMock).toHaveBeenCalledTimes(1);
    expect(clearIntervalMock).not.toHaveBeenCalled();
  });

  it('renders the risk gates page with profile, infra summary, and editable schema fields', async () => {
    const schema: ConfigSchema = {
      version: 'test',
      sections: [
        {
          key: 'policy',
          label: 'Policy',
          description: 'Trade policy knobs.',
          fields: [
            { key: 'edgeRequired', label: 'Edge Required', type: 'number', min: 0, step: 0.01 },
            { key: 'maxEdge', label: 'Max Edge', type: 'number', min: 0, step: 0.01 },
            { key: 'maxSpread', label: 'Max Spread', type: 'number', min: 0, step: 0.01 },
            { key: 'minEdgeTicks', label: 'Min Edge Ticks', type: 'number', integer: true, min: 0 },
            { key: 'requireFreshBook', label: 'Require Fresh Book', type: 'boolean' },
            { key: 'signalMode', label: 'Signal Mode', type: 'enum', options: ['off', 'advisory'] },
            { key: 'topOfBookStabilityMs', label: 'TOB Stability', type: 'number', integer: true, min: 0 },
            { key: 'maxLegSkewMs', label: 'Leg Skew', type: 'number', integer: true, min: 0 },
            { key: 'minDepthLevels', label: 'Depth Levels', type: 'number', integer: true, min: 0 },
            { key: 'depthHeadroomFraction', label: 'Depth Headroom', type: 'number', min: 0, step: 0.01 },
            { key: 'depthBufferMultiplier', label: 'Depth Buffer', type: 'number', min: 0, step: 0.1 }
          ]
        }
      ]
    };
    const config: OpsConfigSnapshot = {
      policy: {
        edgeRequired: 0.03,
        maxEdge: 0.05,
        maxSpread: 0.05,
        minEdgeTicks: 3,
        requireFreshBook: true,
        signalMode: 'off',
        topOfBookStabilityMs: 250,
        maxLegSkewMs: 100,
        minDepthLevels: 3,
        depthHeadroomFraction: 0.25,
        depthBufferMultiplier: 1.5
      },
      risk: {
        maxDailyDrawdownFraction: 0.03
      },
      riskProfile: 'extra_high',
      riskProfileSource: 'api',
      tradingMode: 'paper',
      tradingEnabled: true
    };
    const infra: OpsInfraConfigSnapshot = {
      ops: {
        healthIntervalMs: 5000,
        shutdownTimeoutMs: 5000,
        streamHeartbeatMs: 1000,
        incidentsLimit: 50,
        reconciliationIntervalMs: 30000,
        reconciliationAfterIncidentDelayMs: 5000,
        reconciliationPositionSizeTolerance: 0.01,
        bookRefreshIntervalMs: 1000,
        bookRefreshStaleMs: 5000,
        bookStaleQuarantineThreshold: 2,
        bookStaleQuarantineWindowMs: 10000,
        bookStaleQuarantineCooldownMs: 15000,
        metricsMaxEvents: 1000,
        incidentsMaxEvents: 1000
      },
      eventStore: {
        path: 'data/openpolytrader.db',
        metricsRetentionDays: 7,
        metricsPruneIntervalMs: 60000
      },
      polymarket: {
        clobBaseUrl: 'https://clob.example.com',
        clobTimeoutMs: 1000,
        clobRateLimitPerSecond: 10,
        clobRateLimitWindowMs: 1000,
        clobActiveOrdersPath: '/orders',
        dataApiBaseUrl: 'https://data.example.com',
        dataApiTimeoutMs: 1000,
        wsUrl: 'wss://market.example.com',
        userWsUrl: 'wss://user.example.com',
        wsHeartbeatMs: 1000,
        wsReconnectBaseMs: 100,
        wsReconnectMaxMs: 1000,
        wsReconnectJitterPct: 0.2,
        positionsUserConfigured: true
      },
      rpc: {
        rateLimitWindowMs: 1000,
        waitConfirmations: 2,
        waitTimeoutMs: 5000,
        providers: {
          alchemy: { rpcBaseUrl: 'https://alchemy.example.com', wsBaseUrl: 'wss://alchemy.example.com', apiKeyConfigured: true, rps: 10 },
          quicknode: { rpcBaseUrlConfigured: false, rps: 5 },
          chainstack: { rpcBaseUrl: 'https://chainstack.example.com', wsBaseUrl: 'wss://chainstack.example.com', rps: 5 },
          ankr: { rpcBaseUrl: 'https://ankr.example.com', rpsPhase1: 5, rpsPhase2: 10 },
          privateNode: { rpcBaseUrl: 'https://private.example.com', wsBaseUrl: 'wss://private.example.com', rps: 20 }
        }
      }
    };
    const riskProfiles: OpsRiskProfilesSnapshot = {
      activeProfile: 'extra_high',
      activeProfileSource: 'api',
      availableProfiles: ['near_zero', 'moderate', 'high', 'extra_high']
    };

    mockDashboardReact([
      schema,
      config,
      config,
      infra,
      riskProfiles,
      null,
      'extra_high',
      { saving: false },
      { policy: { saving: false }, risk: { saving: false } },
      false,
      { policy: false, risk: false }
    ]);
    const opsFetchJson = vi.fn(async (path: string) => {
      if (path === '/config/schema') return schema;
      if (path === '/config') return config;
      if (path === '/config/infra') return infra;
      if (path === '/config/risk-profiles') return riskProfiles;
      throw new Error(`Unexpected path: ${path}`);
    });

    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      opsFetchJson
    }));

    const { RiskGates } = await import('../../dashboard/src/pages/RiskGates');
    const element = RiskGates();

    expect(findOne(element, (entry) => entry.props.title === 'Risk Gates')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Infra (env-only)')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Config Settings')).toBeDefined();
    expect(findAll(element, (entry) => textContent(entry.props.children).includes('extra_high (api)')).length).toBeGreaterThan(0);
    expect(findOne(element, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Apply profile')).toBeDefined();
    expect(findAll(element, (entry) => textContent(entry.props.children) === 'Show infra details')).toHaveLength(1);
    expect(findAll(element, (entry) => textContent(entry.props.children) === 'Show all 11 fields')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.type === 'select').length).toBeGreaterThanOrEqual(2);
    expect(findAll(element, (entry) => entry.type === 'input').length).toBeGreaterThan(5);
    expect(opsFetchJson).toHaveBeenNthCalledWith(1, '/config/schema');
    expect(opsFetchJson).toHaveBeenNthCalledWith(2, '/config');
    expect(opsFetchJson).toHaveBeenNthCalledWith(3, '/config/infra');
    expect(opsFetchJson).toHaveBeenNthCalledWith(4, '/config/risk-profiles');
  });
});
