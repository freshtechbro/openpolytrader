import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../../src/config/riskProfile.js');
});

describe('boot config mocked fallbacks', () => {
  it('returns defaults as the active profile source when no profile file can be loaded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadActiveRiskProfile = vi.fn().mockReturnValue(null);
    const loadRiskProfile = vi.fn().mockReturnValue(null);

    vi.doMock('../../src/config/riskProfile.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/riskProfile.js')>(
        '../../src/config/riskProfile.js'
      );
      return {
        ...actual,
        loadActiveRiskProfile,
        loadRiskProfile
      };
    });

    const { loadRuntimePolicyState } = await import('../../src/boot/config.js');
    const { loadEnv } = await import('../../src/config/env.js');
    const state = loadRuntimePolicyState({ env: loadEnv({}), envProfile: null });

    expect(loadRiskProfile).toHaveBeenCalledTimes(2);
    expect(state.activeRiskProfile).toEqual({
      id: 'near_zero',
      source: 'defaults'
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Risk profile missing for high; falling back to near_zero'
    );
  });

  it('stringifies non-Error active-profile failures before warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadActiveRiskProfile = vi.fn().mockImplementation(() => {
      throw 'broken-active-profile';
    });
    const loadRiskProfile = vi.fn().mockReturnValue({
      id: 'high',
      source: 'mock-high.json',
      policy: {},
      risk: {}
    });

    vi.doMock('../../src/config/riskProfile.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/riskProfile.js')>(
        '../../src/config/riskProfile.js'
      );
      return {
        ...actual,
        loadActiveRiskProfile,
        loadRiskProfile
      };
    });

    const { loadRuntimePolicyState } = await import('../../src/boot/config.js');
    const { loadEnv } = await import('../../src/config/env.js');
    const state = loadRuntimePolicyState({ env: loadEnv({}), envProfile: null });

    expect(state.activeRiskProfile).toEqual({
      id: 'high',
      source: 'mock-high.json'
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to load active risk profile: broken-active-profile'
    );
  });

  it('stringifies non-Error profile-load failures before falling back to defaults', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadActiveRiskProfile = vi.fn().mockReturnValue({
      id: 'high',
      source: 'stale-high.json'
    });
    const loadRiskProfile = vi
      .fn()
      .mockImplementationOnce(() => {
        throw 503;
      })
      .mockReturnValue({
        id: 'high',
        source: 'mock-high.json',
        policy: {},
        risk: {}
      });

    vi.doMock('../../src/config/riskProfile.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/riskProfile.js')>(
        '../../src/config/riskProfile.js'
      );
      return {
        ...actual,
        loadActiveRiskProfile,
        loadRiskProfile
      };
    });

    const { loadRuntimePolicyState } = await import('../../src/boot/config.js');
    const { loadEnv } = await import('../../src/config/env.js');
    const state = loadRuntimePolicyState({ env: loadEnv({}), envProfile: null });

    expect(state.activeRiskProfile).toEqual({
      id: 'high',
      source: 'mock-high.json'
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to load risk profile; falling back to defaults: 503'
    );
  });

  it('does not warn about a missing profile when near_zero is already selected', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadActiveRiskProfile = vi.fn().mockReturnValue(null);
    const loadRiskProfile = vi.fn().mockReturnValue(null);

    vi.doMock('../../src/config/riskProfile.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/riskProfile.js')>(
        '../../src/config/riskProfile.js'
      );
      return {
        ...actual,
        loadActiveRiskProfile,
        loadRiskProfile
      };
    });

    const { loadRuntimePolicyState } = await import('../../src/boot/config.js');
    const { loadEnv } = await import('../../src/config/env.js');
    const state = loadRuntimePolicyState({
      env: loadEnv({}),
      envProfile: 'near_zero'
    });

    expect(state.activeRiskProfile).toEqual({
      id: 'near_zero',
      source: 'defaults'
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
