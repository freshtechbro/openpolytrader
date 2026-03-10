import { Link, NavLink } from 'react-router-dom';

import type { OpsTradingStateResponse } from '../../../src/api/contracts.js';
import { TopNav } from '../components/TopNav';
import type { TopNavStreamState } from '../components/TopNav';
import {
  isOpsUnauthorizedError,
  opsFetchJson
} from '../lib/opsClient';
import { OPS_PATHS, type TradingMode } from './opsLayoutUtils';

export function OpsShellView(props: {
  children: React.ReactNode;
  status: string;
  streamState: TopNavStreamState;
  tradingMode: TradingMode | null;
  tradingEnabled: boolean | null;
  onTradingModeChange: (mode: TradingMode) => void;
  onTradingEnabledChange: (enabled: boolean) => void;
  onUnauthorized: () => void;
  onLogout: () => void;
}) {
  const {
    children,
    status,
    streamState,
    tradingMode,
    tradingEnabled,
    onTradingModeChange,
    onTradingEnabledChange,
    onUnauthorized,
    onLogout
  } = props;

  return (
    <div className="app app--ops">
      <TopNav
        title="OpenPolyTrader Ops"
        subtitle="Near-risk-free monitoring console"
        status={status}
        streamState={streamState}
        tradingMode={tradingMode}
        tradingEnabled={tradingEnabled}
        onModeChange={async (mode) => {
          try {
            const confirm = mode === 'live' ? '?confirm=true' : '';
            const response = await opsFetchJson<OpsTradingStateResponse>(
              `/config/trading-mode${confirm}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
              }
            );
            onTradingModeChange(response.state.mode);
          } catch (error) {
            if (isOpsUnauthorizedError(error)) {
              onUnauthorized();
            }
          }
        }}
        onEnabledChange={async (enabled) => {
          try {
            const response = await opsFetchJson<OpsTradingStateResponse>('/config/trading-mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled })
            });
            onTradingEnabledChange(response.state.enabled);
          } catch (error) {
            if (isOpsUnauthorizedError(error)) {
              onUnauthorized();
            }
          }
        }}
      />
      <div className="ops-shell">
        <aside className="ops-shell__nav">
          <nav aria-label="Ops navigation" className="ops-nav">
            {OPS_PATHS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive ? 'ops-nav__link ops-nav__link--active' : 'ops-nav__link'
                }
                end
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ops-shell__actions">
            <Link to="/" className="ops-shell__landing-link">
              Landing
            </Link>
            <button type="button" className="ops-shell__logout" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="ops-shell__main">{children}</main>
      </div>
    </div>
  );
}
