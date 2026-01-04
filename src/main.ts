import 'dotenv/config';

import { loadEnv } from './config/env.js';
import { DEFAULT_RISK_CONFIG } from './config/risk.js';
import { DEFAULT_TRADE_POLICY } from './config/policy.js';
import { MarketAllowlist } from './domain/allowlist.js';
import { OpsAgent } from './agents/ops/OpsAgent.js';
import { MetricsStore } from './telemetry/metrics.js';
import { startOpsServer } from './api/server.js';
import { MarketCatalog } from './services/MarketCatalog.js';
import { PolymarketClob } from './services/PolymarketClob.js';
import { PolymarketRealtime } from './services/PolymarketRealtime.js';
import { IncidentTracker } from './services/IncidentTracker.js';
import { PortfolioAgent } from './agents/portfolio/PortfolioAgent.js';
import { LearningAgent } from './agents/learning/LearningAgent.js';
import { EventStore } from './core/EventStore.js';
import { Supervisor } from './core/Supervisor.js';
import { emitAllowlistSnapshot } from './telemetry/allowlist.js';

const env = loadEnv();

console.log('[boot] openpolytrader starting');
console.log(`[boot] env=${env.NODE_ENV} trading=${env.TRADING_ENABLED}`);
console.log(`[boot] capital=${env.TOTAL_CAPITAL}`);
console.log(
  `[boot] policy edge>=${DEFAULT_TRADE_POLICY.edgeRequired.toFixed(3)} depthHeadroom=${DEFAULT_TRADE_POLICY.depthHeadroomFraction}`
);
console.log(
  `[boot] risk targetTradeFraction=${DEFAULT_RISK_CONFIG.targetTradeFraction} maxDailyDrawdown=${DEFAULT_RISK_CONFIG.maxDailyDrawdownFraction}`
);

const metrics = new MetricsStore();
const allowlist = new MarketAllowlist();
const catalog = new MarketCatalog({ filePath: env.MARKET_CATALOG_PATH });
const marketPairs = catalog.loadPairs();
allowlist.seed(marketPairs.map((pair) => pair.marketId));
metrics.record({
  type: 'info',
  timestamp: Date.now(),
  data: { allowlistSeeded: marketPairs.length }
});
emitAllowlistSnapshot(metrics, allowlist);
const opsAgent = new OpsAgent({ intervalMs: 30000, checks: [] }, metrics);
opsAgent.start();

if (env.OPS_API_ENABLED) {
  startOpsServer(
    { metrics, allowlist, opsAgent },
    { port: env.PORT, host: env.OPS_API_HOST, authToken: env.OPS_API_TOKEN }
  )
    .then(() => {
      console.log(`[boot] ops api listening on ${env.OPS_API_HOST}:${env.PORT}`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[boot] ops api failed to start: ${message}`);
    });
}

const incidentTracker = new IncidentTracker(allowlist, metrics, {
  cooldownMs: DEFAULT_RISK_CONFIG.marketCooldownSeconds * 1000
});
const portfolio = new PortfolioAgent(env.TOTAL_CAPITAL);
const store = new EventStore();
const learning = new LearningAgent({ enabled: env.NODE_ENV !== 'test' }, store);
learning.start();
const clob = new PolymarketClob();
const realtime = new PolymarketRealtime();
const supervisor = new Supervisor(
  {
    marketPairs,
    policy: DEFAULT_TRADE_POLICY,
    riskConfig: DEFAULT_RISK_CONFIG,
    capital: env.TOTAL_CAPITAL
  },
  {
    clob,
    realtime,
    allowlist,
    metrics,
    incidentTracker,
    portfolio
  }
);

void supervisor.start();
