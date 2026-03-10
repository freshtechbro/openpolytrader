import { afterEach, describe, expect, it, vi } from 'vitest';

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
  if (!isElementLike(node)) return '';
  return nestedNodes(node).map(textContent).join('');
}

function mockDashboardReact(stateValues: unknown[] = []) {
  let stateIndex = 0;

  const reactMock = {
    __esModule: true,
    default: {
      Fragment: 'fragment',
      StrictMode: 'strict-mode'
    },
    useState: vi.fn((initial: unknown) => {
      const value = stateIndex < stateValues.length ? stateValues[stateIndex] : initial;
      stateIndex += 1;
      return [value, vi.fn()];
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('react');
  vi.unmock('../../dashboard/node_modules/react/index.js');
  vi.unmock('../../dashboard/src/lib/opsClient');
});

describe('dashboard risk and positions pages', () => {
  it('renders the positions loading shell and starts the initial portfolio refresh', async () => {
    mockDashboardReact([null, null, true]);
    const opsFetchJson = vi.fn(async () => ({
      totalCapital: 100,
      availableCapital: 50,
      dailyPnL: 1,
      marketExposure: {}
    }));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as never);

    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson }));

    const { Positions } = await import('../../dashboard/src/pages/Positions');
    const element = Positions();

    expect(findOne(element, (entry) => entry.props.title === 'Positions')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Portfolio')).toBeDefined();
    expect(textContent(element)).toContain('Loading...');
    expect(opsFetchJson).toHaveBeenCalledWith('/portfolio');
    expect(setIntervalSpy).toHaveBeenCalledOnce();
  });

  it('renders positions error and populated portfolio states faithfully', async () => {
    mockDashboardReact([
      null,
      'Portfolio down',
      false
    ]);
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson: vi.fn(async () => null) }));

    const { Positions } = await import('../../dashboard/src/pages/Positions');
    const errorElement = Positions();

    expect(findOne(errorElement, (entry) => entry.props.title === 'Error')).toBeDefined();
    expect(textContent(errorElement)).toContain('Portfolio down');

    vi.resetModules();
    vi.unmock('../../dashboard/src/lib/opsClient');

    mockDashboardReact([
      {
        totalCapital: 1250.5,
        availableCapital: 930.25,
        dailyPnL: 12.75,
        marketExposure: {
          'A very long market identifier that should truncate': 42.13
        }
      },
      null,
      false
    ]);
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson: vi.fn(async () => null) }));

    const { Positions: PositionsLoaded } = await import('../../dashboard/src/pages/Positions');
    const { MetricsTable } = await import('../../dashboard/src/components/MetricsTable');
    const loadedElement = PositionsLoaded();
    const tables = findAll(loadedElement, (entry) => entry.type === MetricsTable);

    expect(tables).toHaveLength(2);
    expect(tables[0]?.props.rows).toEqual([
      ['Total Capital', '$1250.50'],
      ['Available Capital', '$930.25'],
      ['Daily PnL', '$12.75']
    ]);
    expect(tables[1]?.props.rows).toEqual([['A very long mark...', '$42.13']]);
  });

  it('renders risk gates with collapsed config sections and the default infra summary', async () => {
    mockDashboardReact([
      {
        sections: [
          {
            key: 'policy',
            label: 'Policy',
            description: 'Trading thresholds.',
            fields: Array.from({ length: 12 }, (_, index) => ({
              key: `policyField${index}`,
              label: `Policy Field ${index}`,
              type: 'number',
              integer: false,
              step: 0.01
            }))
          },
          {
            key: 'risk',
            label: 'Risk',
            description: 'Risk controls.',
            fields: [{ key: 'killSwitch', label: 'Kill Switch', type: 'boolean' }]
          }
        ]
      },
      {
        tradingEnabled: true,
        tradingMode: 'shadow',
        riskProfile: 'high',
        riskProfileSource: 'persisted',
        policy: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`policyField${index}`, index + 1])),
        risk: { killSwitch: false }
      },
      {
        tradingEnabled: true,
        tradingMode: 'shadow',
        riskProfile: 'high',
        riskProfileSource: 'persisted',
        policy: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`policyField${index}`, index + 1])),
        risk: { killSwitch: false }
      },
      {
        ops: {
          streamHeartbeatMs: 1000,
          healthIntervalMs: 5000,
          reconciliationIntervalMs: 6000,
          reconciliationAfterIncidentDelayMs: 7000,
          reconciliationPositionSizeTolerance: 0.25,
          incidentsLimit: 50,
          incidentsMaxEvents: 500,
          metricsMaxEvents: 1000
        },
        polymarket: {
          clobBaseUrl: 'https://clob.example',
          clobTimeoutMs: 2000,
          clobRateLimitPerSecond: 10,
          clobRateLimitWindowMs: 1000,
          clobActiveOrdersPath: '/orders',
          dataApiBaseUrl: 'https://data.example',
          dataApiTimeoutMs: 2000,
          wsUrl: 'wss://market.example',
          userWsUrl: 'wss://user.example',
          wsHeartbeatMs: 5000,
          wsReconnectBaseMs: 250,
          wsReconnectMaxMs: 4000,
          wsReconnectJitterPct: 0.2,
          positionsUserConfigured: true
        },
        rpc: {
          rateLimitWindowMs: 1000,
          waitConfirmations: 2,
          waitTimeoutMs: 30000,
          providers: {
            alchemy: {
              rpcBaseUrl: 'https://alchemy.example',
              wsBaseUrl: 'wss://alchemy.example',
              rps: 20,
              apiKeyConfigured: true
            },
            quicknode: {
              rpcBaseUrlConfigured: true,
              rps: 15
            },
            chainstack: {
              rpcBaseUrl: 'https://chainstack.example',
              wsBaseUrl: 'wss://chainstack.example',
              rps: 12
            },
            ankr: {
              rpcBaseUrl: 'https://ankr.example',
              rpsPhase1: 8,
              rpsPhase2: 16
            },
            privateNode: {
              rpcBaseUrl: 'https://private.example',
              wsBaseUrl: 'wss://private.example',
              rps: 30
            }
          }
        }
      },
      {
        activeProfile: 'high',
        activeProfileSource: 'persisted',
        availableProfiles: ['near_zero', 'high']
      },
      null,
      'high',
      { saving: false },
      {
        policy: { saving: false, savedAt: 1_700_000_000_000 },
        risk: { saving: false, error: 'Risk save failed' }
      },
      false,
      { policy: false, risk: false }
    ]);
    const opsFetchJson = vi.fn(async () => null);

    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson }));

    const { RiskGates } = await import('../../dashboard/src/pages/RiskGates');
    const element = RiskGates();

    expect(findOne(element, (entry) => entry.props.title === 'Risk Gates')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Infra Summary')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Policy')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Risk')).toBeDefined();
    expect(
      findOne(
        element,
        (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Show infra details'
      )
    ).toBeDefined();
    expect(
      findOne(
        element,
        (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Show all 12 fields'
      )
    ).toBeDefined();
    expect(textContent(element)).toContain('Active Profile');
    expect(textContent(element)).toContain('Saved');
    expect(textContent(element)).toContain('Risk save failed');
    expect(findAll(element, (entry) => entry.type === 'option')).toHaveLength(2);
    expect(opsFetchJson.mock.calls).toEqual([
      ['/config/schema'],
      ['/config'],
      ['/config/infra'],
      ['/config/risk-profiles']
    ]);
  });

  it('renders the expanded infra details and load-error fallback without editable config schema', async () => {
    mockDashboardReact([
      null,
      null,
      null,
      {
        ops: {
          streamHeartbeatMs: 1000,
          healthIntervalMs: 5000,
          reconciliationIntervalMs: 6000,
          reconciliationAfterIncidentDelayMs: 7000,
          reconciliationPositionSizeTolerance: 0.25,
          incidentsLimit: 50,
          incidentsMaxEvents: 500,
          metricsMaxEvents: 1000
        },
        polymarket: {
          clobBaseUrl: 'https://clob.example',
          clobTimeoutMs: 2000,
          clobRateLimitPerSecond: 10,
          clobRateLimitWindowMs: 1000,
          clobActiveOrdersPath: '/orders',
          dataApiBaseUrl: 'https://data.example',
          dataApiTimeoutMs: 2000,
          wsUrl: 'wss://market.example',
          userWsUrl: 'wss://user.example',
          wsHeartbeatMs: 5000,
          wsReconnectBaseMs: 250,
          wsReconnectMaxMs: 4000,
          wsReconnectJitterPct: 0.2,
          positionsUserConfigured: true
        },
        rpc: {
          rateLimitWindowMs: 1000,
          waitConfirmations: 2,
          waitTimeoutMs: 30000,
          providers: {
            alchemy: {
              rpcBaseUrl: 'https://alchemy.example',
              wsBaseUrl: 'wss://alchemy.example',
              rps: 20,
              apiKeyConfigured: true
            },
            quicknode: {
              rpcBaseUrlConfigured: true,
              rps: 15
            },
            chainstack: {
              rpcBaseUrl: 'https://chainstack.example',
              wsBaseUrl: 'wss://chainstack.example',
              rps: 12
            },
            ankr: {
              rpcBaseUrl: 'https://ankr.example',
              rpsPhase1: 8,
              rpsPhase2: 16
            },
            privateNode: {
              rpcBaseUrl: 'https://private.example',
              wsBaseUrl: 'wss://private.example',
              rps: 30
            }
          }
        }
      },
      null,
      'Config load failed',
      'near_zero',
      { saving: false, warning: 'Profile applied but could not be persisted (will reset on restart).' },
      {
        policy: { saving: false },
        risk: { saving: false }
      },
      true,
      { policy: false, risk: false }
    ]);
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson: vi.fn(async () => null) }));

    const { RiskGates } = await import('../../dashboard/src/pages/RiskGates');
    const element = RiskGates();

    expect(findOne(element, (entry) => entry.props.title === 'Ops / Streams')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Polymarket')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'RPC')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Settings')).toBeDefined();
    expect(textContent(element)).toContain('Config load failed');
    expect(textContent(element)).toContain('Config schema not available.');
  });
});
