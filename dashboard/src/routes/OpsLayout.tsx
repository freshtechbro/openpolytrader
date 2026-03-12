import { useEffect } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';

import { OpsAuthView } from './OpsAuthView';
import { OpsLayoutContent } from './OpsLayoutContent';
import { OpsShellView } from './OpsShellView';
import {
  canonicalOpsPath,
  resolveOpsPage
} from './opsLayoutUtils';
import { useOpsLayoutController } from './useOpsLayoutController';

function replaceWithCanonicalOpsPath(pathname: string, navigate: NavigateFunction): void {
  const target = canonicalOpsPath(pathname);
  if (target !== pathname) {
    navigate(target, { replace: true });
  }
}

function createRetryHandler(refreshSession: () => Promise<void>): () => void {
  return () => {
    void refreshSession();
  };
}

export function OpsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const controller = useOpsLayoutController();
  const currentPage = resolveOpsPage(location.pathname);
  const handleRetry = createRetryHandler(controller.refreshSession);

  useEffect(() => {
    replaceWithCanonicalOpsPath(location.pathname, navigate);
  }, [location.pathname, navigate]);

  if (!controller.session.authenticated) {
    return (
      <OpsAuthView
        session={controller.session}
        loginToken={controller.loginToken}
        loginSubmitting={controller.loginState.submitting}
        loginError={controller.loginState.error}
        onLoginTokenChange={controller.setLoginToken}
        onLoginSubmit={controller.handleLoginSubmit}
        onRetry={handleRetry}
      />
    );
  }

  return (
    <OpsShellView
      status={controller.health?.status ?? 'degraded'}
      streamState={controller.topNavStreamState}
      tradingMode={controller.tradingMode}
      tradingEnabled={controller.tradingEnabled}
      onTradingModeChange={controller.setTradingMode}
      onTradingEnabledChange={controller.setTradingEnabled}
      onUnauthorized={controller.handleUnauthorized}
      onLogout={controller.handleLogout}
    >
      <OpsLayoutContent
        allowlist={controller.allowlist}
        currentPage={currentPage}
        expanded={controller.expanded}
        health={controller.health}
        incidents={controller.incidents}
        intents={controller.finalIntents}
        metrics={controller.metrics}
        onToggleExpanded={controller.toggleExpanded}
        slo={controller.slo}
      />
    </OpsShellView>
  );
}
