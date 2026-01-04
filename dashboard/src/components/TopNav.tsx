import { StatusPill } from './StatusPill';

interface TopNavProps {
  title: string;
  subtitle: string;
  status: 'healthy' | 'degraded';
  streamConnected: boolean;
}

export function TopNav({ title, subtitle, status, streamConnected }: TopNavProps) {
  return (
    <header className="topnav">
      <div>
        <p className="topnav__title">{title}</p>
        <p className="topnav__subtitle">{subtitle}</p>
      </div>
      <div className="topnav__status">
        <StatusPill status={status} />
        <span className={`stream ${streamConnected ? 'stream--on' : 'stream--off'}`}>
          {streamConnected ? 'Stream live' : 'Stream offline'}
        </span>
      </div>
    </header>
  );
}
