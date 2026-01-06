import { StatusPill } from './StatusPill';

type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

interface TopNavProps {
  title: string;
  subtitle: string;
  status: 'healthy' | 'degraded';
  streamConnected: boolean;
  tradingMode: TradingMode | null;
  tradingEnabled: boolean | null;
}

function getTradingModeLabel(mode: TradingMode | null): string {
  if (mode === null) return 'Unknown';
  const labels: Record<TradingMode, string> = {
    off: 'Off',
    shadow: 'Shadow',
    paper: 'Paper',
    live: 'Live'
  };
  return labels[mode] ?? 'Unknown';
}

function getTradingModeVariant(mode: TradingMode | null, enabled: boolean | null): 'off' | 'shadow' | 'paper' | 'live' | 'disabled' {
  if (enabled === false) return 'disabled';
  if (mode === null) return 'off';
  return mode;
}

export function TopNav({ title, subtitle, status, streamConnected, tradingMode, tradingEnabled }: TopNavProps) {
  const modeVariant = getTradingModeVariant(tradingMode, tradingEnabled);
  const modeLabel = getTradingModeLabel(tradingMode);
  const enabledLabel = tradingEnabled === null ? '' : tradingEnabled ? 'Enabled' : 'Disabled';

  return (
    <header className="topnav">
      <div>
        <p className="topnav__title">{title}</p>
        <p className="topnav__subtitle">{subtitle}</p>
      </div>
      <div className="topnav__status">
        <span className={`trading-mode trading-mode--${modeVariant}`}>
          <span className="trading-mode__label">Mode</span>
          <span className="trading-mode__value">{modeLabel}</span>
          {enabledLabel && <span className="trading-mode__enabled">{enabledLabel}</span>}
        </span>
        <StatusPill status={status} />
        <span className={`stream ${streamConnected ? 'stream--on' : 'stream--off'}`}>
          {streamConnected ? 'Stream live' : 'Stream offline'}
        </span>
      </div>
    </header>
  );
}
