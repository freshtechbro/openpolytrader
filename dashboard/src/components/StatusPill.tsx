interface StatusPillProps {
  status: 'healthy' | 'degraded';
}

export function StatusPill({ status }: StatusPillProps) {
  return (
    <span className={`status-pill status-pill--${status}`} aria-live="polite">
      {status === 'healthy' ? 'Healthy' : 'Degraded'}
    </span>
  );
}
