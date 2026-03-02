import { StatusPill } from './StatusPill';
import { GitHubRepoLink } from './GitHubRepoLink';

type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

interface TopNavProps {
  title: string;
  subtitle: string;
  status: 'healthy' | 'degraded';
  streamConnected: boolean;
  tradingMode: TradingMode | null;
  tradingEnabled: boolean | null;
  onModeChange?: (mode: TradingMode) => void;
  onEnabledChange?: (enabled: boolean) => void;
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

export function TopNav({ title, subtitle, status, streamConnected, tradingMode, tradingEnabled, onModeChange, onEnabledChange }: TopNavProps) {
  const modeVariant = getTradingModeVariant(tradingMode, tradingEnabled);
  const modeLabel = getTradingModeLabel(tradingMode);
  const enabledLabel = tradingEnabled === null ? '' : tradingEnabled ? 'Enabled' : 'Disabled';

  const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newMode = e.target.value as TradingMode;
    if (newMode === 'live') {
      const confirmed = window.confirm(
        'WARNING: Live trading will execute REAL orders with REAL money.\n\nAre you sure you want to enable live trading?'
      );
      if (!confirmed) {
        e.target.value = tradingMode ?? 'shadow';
        return;
      }
    }
    onModeChange?.(newMode);
  };

  const handleEnabledToggle = () => {
    onEnabledChange?.(!tradingEnabled);
  };

  return (
    <header className="topnav">
      <div className="topnav__brand">
        <GitHubRepoLink />
        <div>
          <p className="topnav__title">{title}</p>
          <p className="topnav__subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="topnav__status">
        <span className={`trading-mode trading-mode--${modeVariant}`}>
          <span className="trading-mode__label">Mode</span>
          {onModeChange ? (
            <select
              className="trading-mode__select"
              value={tradingMode ?? 'shadow'}
              onChange={handleModeChange}
              aria-label="Trading mode"
            >
              <option value="off">Off</option>
              <option value="shadow">Shadow</option>
              <option value="paper">Paper</option>
              <option value="live">Live</option>
            </select>
          ) : (
            <span className="trading-mode__value">{modeLabel}</span>
          )}
          {onEnabledChange ? (
            <button
              type="button"
              className={`trading-mode__toggle ${tradingEnabled ? 'trading-mode__toggle--on' : 'trading-mode__toggle--off'}`}
              onClick={handleEnabledToggle}
              aria-label={tradingEnabled ? 'Disable trading' : 'Enable trading'}
            >
              {enabledLabel}
            </button>
          ) : (
            enabledLabel && <span className="trading-mode__enabled">{enabledLabel}</span>
          )}
        </span>
        <StatusPill status={status} />
        <span className={`stream ${streamConnected ? 'stream--on' : 'stream--off'}`}>
          {streamConnected ? 'Stream live' : 'Stream offline'}
        </span>
      </div>
    </header>
  );
}
