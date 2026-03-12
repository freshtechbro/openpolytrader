import { useEffect, useState } from 'react';
import { STREAM_WATCHDOG_MS } from '../lib/dashboardConfig';
import type { JsonValue } from '../lib/json';

export interface StreamEvent {
  type: string;
  timestamp: number;
  data: JsonValue;
}

type ActivityTracker = { lastActivityAt: number };
type SetConnected = (value: boolean) => void;
type SetLastEvent = (value: StreamEvent | null) => void;

const STREAM_EVENT_TYPES = [
  'health',
  'incident',
  'opportunity',
  'order',
  'fill',
  'risk',
  'info',
  'metric_error',
  'latency',
  'execution_lifecycle',
  'book_staleness',
  'slo_violation',
  'gate_rejection',
  'shadow_decision',
  'llm_decision',
  'allowlist_updated',
  'trading_mode_changed',
  'trading_enabled_changed',
  'stream_ping'
] as const;

function parseStreamEvent(event: Event): StreamEvent | null {
  const payload = (event as MessageEvent).data;
  if (typeof payload !== 'string') return null;
  try {
    return JSON.parse(payload) as StreamEvent;
  } catch {
    return null;
  }
}

function addStreamListeners(source: EventSource, listener: (event: Event) => void): void {
  for (const eventType of STREAM_EVENT_TYPES) {
    source.addEventListener(eventType, listener);
  }
}

function markStreamActivity(activity: ActivityTracker, setConnected: SetConnected): void {
  activity.lastActivityAt = Date.now();
  setConnected(true);
}

function createOpenHandler(activity: ActivityTracker, setConnected: SetConnected): () => void {
  return () => {
    markStreamActivity(activity, setConnected);
  };
}

function createErrorHandler(setConnected: SetConnected): () => void {
  return () => {
    // Treat any stream error as a disconnected state; UI debounce handles reconnect jitter.
    setConnected(false);
  };
}

function createStreamEventHandler(
  activity: ActivityTracker,
  setConnected: SetConnected,
  setLastEvent: SetLastEvent,
  onEvent?: (event: StreamEvent) => void
): (event: Event) => void {
  return (event: Event) => {
    const parsed = parseStreamEvent(event);
    if (!parsed) return;

    markStreamActivity(activity, setConnected);
    setLastEvent(parsed);
    onEvent?.(parsed);
  };
}

function createWatchdogHandler(activity: ActivityTracker, setConnected: SetConnected): () => void {
  return () => {
    if (Date.now() - activity.lastActivityAt > STREAM_WATCHDOG_MS) {
      setConnected(false);
    }
  };
}

export function useEventStream(url: string | null, onEvent?: (event: StreamEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<StreamEvent | null>(null);

  useEffect(() => {
    if (!url) {
      setConnected(false);
      setLastEvent(null);
      return;
    }

    const source = new EventSource(url, { withCredentials: true });
    const activity = { lastActivityAt: Date.now() };
    const handleStreamEvent = createStreamEventHandler(activity, setConnected, setLastEvent, onEvent);

    source.onopen = createOpenHandler(activity, setConnected);
    source.onerror = createErrorHandler(setConnected);
    addStreamListeners(source, handleStreamEvent);

    const watchdog = window.setInterval(createWatchdogHandler(activity, setConnected), 1000);

    return () => {
      window.clearInterval(watchdog);
      source.close();
    };
  }, [url, onEvent]);

  return [{ connected, lastEvent }] as const;
}
