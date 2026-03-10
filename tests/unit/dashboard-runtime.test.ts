import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  static latest: FakeEventSource | null = null;

  onopen?: () => void;
  onerror?: () => void;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly listeners = new Map<string, (event: { data: unknown }) => void>();

  constructor(
    readonly url: string,
    readonly options: unknown
  ) {
    FakeEventSource.latest = this;
    this.addEventListener = vi.fn((type: string, handler: (event: { data: unknown }) => void) => {
      this.listeners.set(type, handler);
    });
    this.close = vi.fn();
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data });
  }
}

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('react');
  vi.unmock('react-dom/client');
  vi.unmock('react-router-dom');
  vi.unmock('../../dashboard/src/App');
  vi.unmock('../../dashboard/node_modules/react/index.js');
  vi.unmock('../../dashboard/node_modules/react-dom/client.js');
  FakeEventSource.latest = null;
  for (const name of ['window', 'document', 'EventSource', 'fetch']) {
    Reflect.deleteProperty(globalThis as Record<string, unknown>, name);
  }
});

describe('dashboard runtime seams', () => {
  it('handles null and live stream lifecycles in useEventStream', async () => {
    const setConnected = vi.fn();
    const setLastEvent = vi.fn();
    let cleanup: (() => void) | undefined;
    let intervalCallback: (() => void) | undefined;
    let nowMs = 1000;
    const clearInterval = vi.fn();
    let stateIndex = 0;

    const reactMock = {
      __esModule: true,
      default: {
        StrictMode: 'strict-mode'
      },
      useState: vi.fn((value: unknown) => {
        stateIndex += 1;
        return stateIndex % 2 === 1 ? [value, setConnected] : [value, setLastEvent];
      }),
      useEffect: (effect: () => void | (() => void)) => {
        cleanup = effect() ?? undefined;
      },
      useMemo: (factory: () => unknown) => factory()
    };

    vi.doMock('react', () => reactMock);
    vi.doMock('../../dashboard/node_modules/react/index.js', () => reactMock);

    setGlobal('EventSource', FakeEventSource);
    setGlobal('window', {
      setInterval: vi.fn((callback: () => void) => {
        intervalCallback = callback;
        return 99;
      }),
      clearInterval
    });
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const { useEventStream } = await import('../../dashboard/src/hooks/useEventStream');

    const idleState = useEventStream(null);
    expect(idleState).toEqual([{ connected: false, lastEvent: null }]);
    expect(setConnected).toHaveBeenCalledWith(false);
    expect(setLastEvent).toHaveBeenCalledWith(null);

    setConnected.mockClear();
    setLastEvent.mockClear();
    cleanup = undefined;

    const onEvent = vi.fn();
    const activeState = useEventStream('https://desk.local/stream', onEvent);
    const source = FakeEventSource.latest;

    expect(activeState).toEqual([{ connected: false, lastEvent: null }]);
    expect(source?.url).toBe('https://desk.local/stream');
    expect(source?.options).toEqual({ withCredentials: true });
    expect(source?.addEventListener).toHaveBeenCalledTimes(19);

    source?.onopen?.();
    expect(setConnected).toHaveBeenCalledWith(true);

    const payload = { type: 'health', timestamp: 1, data: { ok: true } };
    source?.emit('health', JSON.stringify(payload));
    source?.emit('health', '{bad json');
    source?.emit('health', 42);

    expect(setLastEvent).toHaveBeenCalledWith(payload);
    expect(onEvent).toHaveBeenCalledWith(payload);

    source?.onerror?.();
    expect(setConnected).toHaveBeenCalledWith(false);

    nowMs += 50000;
    intervalCallback?.();
    expect(setConnected).toHaveBeenLastCalledWith(false);

    cleanup?.();
    expect(clearInterval).toHaveBeenCalledWith(99);
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it('builds ops urls, manages stream tokens, and parses JSON responses', async () => {
    const fetchMock = vi.fn();
    setGlobal('fetch', fetchMock);
    setGlobal('window', {
      location: {
        href: 'https://ops.local/dashboard',
        hostname: 'ops.local'
      }
    });
    setGlobal('document', {
      cookie: ''
    });

    const {
      OPS_BASE,
      OPS_STREAM_URL,
      OpsRequestError,
      buildOpsUrl,
      clearOpsAuthToken,
      clearOpsSession,
      createOpsSession,
      getOpsSession,
      getOpsStreamUrl,
      isOpsUnauthorizedError,
      opsFetchJson,
      setOpsAuthToken
    } = await import('../../dashboard/src/lib/opsClient');

    expect(OPS_BASE).toBe('');
    expect(OPS_STREAM_URL).toBe('/stream');
    expect(buildOpsUrl('health')).toBe('/health');

    setOpsAuthToken('  token-123  ');
    expect(getOpsStreamUrl()).toBe('/stream?token=token-123');

    setGlobal('document', { cookie: 'ops_session=abc123' });
    expect(getOpsStreamUrl()).toBe('/stream');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}'
    });
    await expect(opsFetchJson<{ ok: boolean }>('/metrics')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/metrics',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.any(Headers)
      })
    );
    expect((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers instanceof Headers).toBe(true);
    expect(((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers as Headers).get('x-ops-token')).toBe('token-123');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => ''
    });
    await expect(getOpsSession({ prefill: true })).rejects.toMatchObject({
      path: '/ops/session?prefill=1',
      status: 200,
      code: 'invalid_json'
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"authenticated":true}'
    });
    await expect(createOpsSession('token-123')).resolves.toEqual({ authenticated: true });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"authenticated":false}'
    });
    await expect(clearOpsSession()).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    });
    await expect(opsFetchJson('/health')).rejects.toMatchObject({
      path: '/health',
      status: 200,
      code: 'invalid_json'
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":{"code":"unauthorized","message":"Nope","details":{"hint":"login"}}}'
    });
    await expect(opsFetchJson('/health')).rejects.toMatchObject({
      path: '/health',
      status: 401,
      code: 'unauthorized',
      message: 'Nope',
      details: { hint: 'login' }
    });

    const error = new OpsRequestError('/health', 401, 'unauthorized');
    expect(isOpsUnauthorizedError(error)).toBe(true);

    clearOpsAuthToken();
    expect(getOpsStreamUrl()).toBe('/stream');
  });

  it('boots the dashboard entrypoint when the root container exists', async () => {
    const render = vi.fn();
    const createRoot = vi.fn(() => ({ render }));
    const container = { id: 'root' };
    const getElementById = vi.fn(() => container);

    setGlobal('document', { getElementById });
    vi.doMock('react-dom/client', () => ({ createRoot }));
    vi.doMock('../../dashboard/node_modules/react-dom/client.js', () => ({ createRoot }));
    vi.doMock('../../dashboard/src/App', () => ({
      App: () => 'App'
    }));

    await import('../../dashboard/src/main');

    expect(getElementById).toHaveBeenCalledWith('root');
    expect(createRoot).toHaveBeenCalledWith(container);
    expect(render).toHaveBeenCalledOnce();
  });

  it('throws when the dashboard root container is missing', async () => {
    const createRoot = vi.fn();
    setGlobal('document', { getElementById: vi.fn(() => null) });
    vi.doMock('react-dom/client', () => ({ createRoot }));
    vi.doMock('../../dashboard/node_modules/react-dom/client.js', () => ({ createRoot }));
    vi.doMock('../../dashboard/src/App', () => ({
      App: () => 'App'
    }));

    await expect(import('../../dashboard/src/main')).rejects.toThrow('Root container not found');
    expect(createRoot).not.toHaveBeenCalled();
  });
});
