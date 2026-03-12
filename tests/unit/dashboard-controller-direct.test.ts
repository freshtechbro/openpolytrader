import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('useRiskGatesController', () => {
  it('loads the config snapshot on mount and exposes save/profile handlers', async () => {
    const { setters } = mockDashboardReact([
      {
        sections: [
          {
            key: 'policy',
            label: 'Policy',
            description: 'Policy fields',
            fields: [
              { key: 'edgeRequired', label: 'Edge Required', type: 'number', integer: false },
              { key: 'fwRequireConverged', label: 'FW Require Converged', type: 'boolean' }
            ]
          },
          {
            key: 'risk',
            label: 'Risk',
            description: 'Risk fields',
            fields: [{ key: 'marketCooldownSeconds', label: 'Cooldown', type: 'number', integer: true }]
          }
        ]
      },
      {
        tradingEnabled: true,
        tradingMode: 'shadow',
        riskProfile: 'near_zero',
        riskProfileSource: 'persisted',
        policy: { edgeRequired: 0.03, fwRequireConverged: true },
        risk: { marketCooldownSeconds: 60 }
      },
      {
        tradingEnabled: true,
        tradingMode: 'shadow',
        riskProfile: 'near_zero',
        riskProfileSource: 'persisted',
        policy: { edgeRequired: 0.04, fwRequireConverged: false },
        risk: { marketCooldownSeconds: 60 }
      },
      { ops: {}, polymarket: {}, rpc: {} },
      { activeProfile: 'near_zero', activeProfileSource: 'persisted', availableProfiles: ['near_zero', 'high'] },
      null,
      'high',
      { saving: false },
      { policy: { saving: false }, risk: { saving: false } },
      false,
      { policy: false, risk: false }
    ]);

    const opsFetchJson = vi
      .fn()
      .mockResolvedValueOnce({ sections: [] })
      .mockResolvedValueOnce({
        tradingEnabled: true,
        tradingMode: 'shadow',
        riskProfile: 'near_zero',
        riskProfileSource: 'persisted',
        policy: { edgeRequired: 0.03, fwRequireConverged: true },
        risk: { marketCooldownSeconds: 60 }
      })
      .mockResolvedValueOnce({ ops: {}, polymarket: {}, rpc: {} })
      .mockResolvedValueOnce({ activeProfile: 'near_zero', activeProfileSource: 'persisted', availableProfiles: ['near_zero', 'high'] })
      .mockResolvedValueOnce({ policy: { edgeRequired: 0.04, fwRequireConverged: false } })
      .mockResolvedValueOnce({
        profile: { id: 'high', source: 'persisted' },
        policy: { edgeRequired: 0.05, fwRequireConverged: false },
        risk: { marketCooldownSeconds: 90 },
        persisted: true
      });

    vi.doMock('../../dashboard/src/lib/opsClient', () => ({ opsFetchJson }));

    const { useRiskGatesController } = await import('../../dashboard/src/pages/risk-gates/useRiskGatesController');
    const controller = useRiskGatesController();
    await Promise.resolve();
    await Promise.resolve();

    expect(opsFetchJson.mock.calls.slice(0, 4).map((call) => call[0])).toEqual([
      '/config/schema',
      '/config',
      '/config/infra',
      '/config/risk-profiles'
    ]);

    await controller.handleSave('policy');
    expect(opsFetchJson).toHaveBeenCalledWith(
      '/config/policy',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ edgeRequired: 0.04, fwRequireConverged: false })
      })
    );

    controller.handleProfileDraftChange('high');
    await controller.handleProfileApply();
    expect(opsFetchJson).toHaveBeenCalledWith(
      '/config/risk-profile',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ profile: 'high' })
      })
    );
    expect(setters[1]).toHaveBeenCalledWith(
      expect.objectContaining({
        riskProfile: 'high',
        riskProfileSource: 'persisted',
        policy: { edgeRequired: 0.05, fwRequireConverged: false },
        risk: { marketCooldownSeconds: 90 }
      })
    );
    expect(setters[2]).toHaveBeenCalledWith(
      expect.objectContaining({
        riskProfile: 'high',
        riskProfileSource: 'persisted',
        policy: { edgeRequired: 0.05, fwRequireConverged: false },
        risk: { marketCooldownSeconds: 90 }
      })
    );
    expect(setters[6]).toHaveBeenCalledWith('high');
    const riskProfilesUpdater = setters[4].mock.calls.at(-1)?.[0] as
      | ((value: { activeProfile: string; activeProfileSource: string; availableProfiles: string[] }) => unknown)
      | undefined;
    expect(riskProfilesUpdater?.({ activeProfile: 'near_zero', activeProfileSource: 'persisted', availableProfiles: ['near_zero', 'high'] })).toMatchObject({
      activeProfile: 'high',
      activeProfileSource: 'persisted',
      availableProfiles: ['near_zero', 'high']
    });
    expect(setters[7]).toHaveBeenCalledWith(
      expect.objectContaining({
        saving: false
      })
    );

    controller.toggleInfra();
    controller.toggleSectionExpansion('policy');

    expect(setters[9]).toHaveBeenCalledWith(expect.any(Function));
    expect(setters[10]).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe('useOpsLayoutController', () => {
  it('refreshes the session, bootstraps ops data, and exposes login/logout handlers', async () => {
    const { setters } = mockDashboardReact([
      { checking: false, authenticated: true, authRequired: true, error: null },
      'token-123',
      { submitting: false, error: null },
      null,
      null,
      null,
      [],
      [],
      [],
      false,
      'shadow',
      true,
      true,
      false
    ]);

    const opsFetchJson = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: true, authRequired: true })
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ counts: {}, lastEventAt: 1_700_000_000_000 })
      .mockResolvedValueOnce({ aggregates: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ tradingMode: 'shadow', tradingEnabled: true });
    const getOpsSession = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: true, authRequired: true })
      .mockResolvedValueOnce({ authenticated: true, authRequired: true });
    const createOpsSession = vi.fn(async () => ({ authenticated: true, authRequired: true }));
    const clearOpsSession = vi.fn(async () => undefined);
    const setOpsAuthToken = vi.fn();
    const clearOpsAuthToken = vi.fn();

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: () => [{ connected: true }]
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      clearOpsAuthToken,
      clearOpsSession,
      createOpsSession,
      getOpsSession,
      getOpsStreamUrl: () => '/stream',
      isOpsUnauthorizedError: () => false,
      opsFetchJson,
      setOpsAuthToken
    }));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as never);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout
    });

    const { useOpsLayoutController } = await import('../../dashboard/src/routes/useOpsLayoutController');
    const controller = useOpsLayoutController();
    await Promise.resolve();
    await Promise.resolve();

    expect(getOpsSession).toHaveBeenCalled();
    expect(opsFetchJson.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['/health', '/metrics', '/slo', '/markets', '/incidents', '/config'])
    );
    expect(controller.topNavStreamState).toBe('live');
    expect(setIntervalSpy).toHaveBeenCalled();

    await controller.handleLoginSubmit({ preventDefault: vi.fn() } as never);
    expect(setOpsAuthToken).toHaveBeenCalledWith('token-123');
    expect(createOpsSession).toHaveBeenCalledWith('token-123');

    await controller.handleLogout();
    expect(clearOpsSession).toHaveBeenCalledOnce();
    expect(clearOpsTokenOrSessionReset(setters[0], clearOpsAuthToken)).toBe(true);

    clearIntervalSpy.mockRestore();
  });
});

describe('ops layout controller support helpers', () => {
  it('normalizes stream/session helpers and reconciles intent metadata', async () => {
    const {
      asAllowlist,
      asIncidents,
      asTradingMode,
      createSessionState,
      getStreamState,
      reconcileIntentMetadata,
      shouldRefreshMetrics,
      syncLatencyIntent,
      syncOrderIntent,
      toLiveDecision
    } = await import('../../dashboard/src/routes/opsLayoutControllerSupport');

    expect(asAllowlist([{ marketId: 'm1' }])).toHaveLength(1);
    expect(asIncidents([{ id: 'incident-1' }])).toHaveLength(1);
    expect(asTradingMode('shadow')).toBe('shadow');
    expect(asTradingMode('bad-mode')).toBeNull();
    expect(createSessionState(true, true)).toEqual({
      checking: false,
      authenticated: true,
      authRequired: true,
      error: null
    });

    const latencyEvent = {
      type: 'latency',
      timestamp: 1_700_000_000_000,
      data: {
        stage: 'gated',
        opportunityId: '0xabc123456789012345678901234567890123456:yes:0.42:1700000000',
        marketId: '0xabc123456789012345678901234567890123456',
        strategy: 'near_zero'
      }
    };
    const liveDecision = toLiveDecision(latencyEvent, '', '');
    expect(liveDecision).toMatchObject({
      opportunityId: '0xabc123456789012345678901234567890123456:yes:0.42:1700000000',
      marketId: '0xabc123456789012345678901234567890123456'
    });

    const allowlist = [
      {
        key: '0xabc123456789012345678901234567890123456',
        question: 'Will it happen?'
      }
    ] as never[];
    const syncedLatency = syncLatencyIntent([], liveDecision!, allowlist);
    expect(syncedLatency[0]).toMatchObject({ marketQuestion: 'Will it happen?' });

    const orderEvent = {
      type: 'order',
      timestamp: 1_700_000_000_100,
      data: {
        opportunityId: '0xabc123456789012345678901234567890123456:yes:0.42:1700000000',
        marketId: '0xabc123456789012345678901234567890123456',
        status: 'submitted',
        reason: 'ok',
        strategy: 'near_zero'
      }
    };
    const syncedOrder = syncOrderIntent(syncedLatency, orderEvent, allowlist);
    expect(syncedOrder[0]).toMatchObject({
      executedAt: 1_700_000_000_100,
      orderStatus: 'submitted',
      orderReason: 'ok'
    });

    const reconciled = reconcileIntentMetadata(
      [
        {
          ...syncedOrder[0]!,
          marketId: undefined,
          marketQuestion: null
        }
      ],
      allowlist
    );
    expect(reconciled[0]).toMatchObject({
      marketId: '0xabc123456789012345678901234567890123456',
      marketQuestion: 'Will it happen?'
    });
    expect(getStreamState({ type: 'trading_mode_changed', data: { state: { mode: 'paper' } } })).toEqual({
      mode: 'paper'
    });
    expect(shouldRefreshMetrics({ type: 'fill' })).toBe(true);
    expect(shouldRefreshMetrics({ type: 'health' })).toBe(false);

    const basketOrder = syncOrderIntent(
      [],
      {
        type: 'order',
        timestamp: 1_700_000_000_200,
        data: {
          opportunityId: 'fw-basket:basket-1:1700000000',
          status: 'submitted',
          basket: {
            legs: [
              {
                marketId: '0xabc123456789012345678901234567890123456'
              }
            ]
          }
        }
      },
      allowlist
    );
    expect(basketOrder[0]).toMatchObject({
      marketId: '0xabc123456789012345678901234567890123456',
      marketQuestion: 'Will it happen?',
      strategy: 'fw_basket',
      orderStatus: 'submitted'
    });
  });
});

function clearOpsTokenOrSessionReset(
  sessionSetter: ReturnType<typeof vi.fn>,
  clearOpsAuthToken: ReturnType<typeof vi.fn>
): boolean {
  return sessionSetter.mock.calls.length > 0 || clearOpsAuthToken.mock.calls.length > 0;
}
