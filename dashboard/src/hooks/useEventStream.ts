import { useEffect, useMemo, useState } from 'react';

export interface StreamEvent {
  type: string;
  timestamp: number;
  data: any;
}

export function useEventStream(url: string, onEvent?: (event: StreamEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<StreamEvent | null>(null);

  useEffect(() => {
    const source = new EventSource(url);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('health', handle);
    source.addEventListener('incident', handle);
    source.addEventListener('opportunity', handle);
    source.addEventListener('order', handle);
    source.addEventListener('fill', handle);
    source.addEventListener('risk', handle);
    source.addEventListener('info', handle);
    source.addEventListener('error', handle);

    function handle(event: MessageEvent) {
      const parsed = JSON.parse(event.data) as StreamEvent;
      setLastEvent(parsed);
      onEvent?.(parsed);
    }

    return () => {
      source.close();
    };
  }, [url]);

  return useMemo(
    () => [{ connected, lastEvent }] as const,
    [connected, lastEvent]
  );
}
