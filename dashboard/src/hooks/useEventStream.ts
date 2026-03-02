import { useEffect, useMemo, useState } from 'react';

export interface StreamEvent {
  type: string;
  timestamp: number;
  data: any;
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

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setConnected(false);
      }
    };

    source.addEventListener('health', handle);
    source.addEventListener('incident', handle);
    source.addEventListener('opportunity', handle);
    source.addEventListener('order', handle);
    source.addEventListener('fill', handle);
    source.addEventListener('risk', handle);
    source.addEventListener('info', handle);
    source.addEventListener('metric_error', handle);
    source.addEventListener('latency', handle);
    source.addEventListener('execution_lifecycle', handle);
    source.addEventListener('book_staleness', handle);
    source.addEventListener('slo_violation', handle);
    source.addEventListener('gate_rejection', handle);
    source.addEventListener('shadow_decision', handle);
    source.addEventListener('llm_decision', handle);
    source.addEventListener('allowlist_updated', handle);
    source.addEventListener('trading_mode_changed', handle);
    source.addEventListener('trading_enabled_changed', handle);

    function handle(event: Event) {
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string') return;

      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(data) as StreamEvent;
      } catch {
        return;
      }
      setConnected(true);
      setLastEvent(parsed);
      onEvent?.(parsed);
    }

    return () => {
      source.close();
    };
  }, [url, onEvent]);

  return useMemo(
    () => [{ connected, lastEvent }] as const,
    [connected, lastEvent]
  );
}
