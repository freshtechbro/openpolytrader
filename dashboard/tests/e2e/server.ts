import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', '..', 'dist');
const indexPath = resolve(distDir, 'index.html');

const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

const infraSnapshot = {
  ops: {
    healthIntervalMs: 1000,
    streamHeartbeatMs: 1000,
    incidentsLimit: 100,
    reconciliationIntervalMs: 0,
    reconciliationAfterIncidentDelayMs: 0,
    reconciliationPositionSizeTolerance: 0.000001,
    metricsMaxEvents: 1000,
    incidentsMaxEvents: 1000
  },
  polymarket: {
    clobBaseUrl: 'http://localhost',
    clobTimeoutMs: 1000,
    clobRateLimitPerSecond: 10,
    clobRateLimitWindowMs: 1000,
    clobActiveOrdersPath: '/data/orders',
    dataApiBaseUrl: 'http://localhost',
    dataApiTimeoutMs: 1000,
    wsUrl: 'ws://localhost',
    userWsUrl: 'ws://localhost',
    wsHeartbeatMs: 1000,
    wsReconnectBaseMs: 100,
    wsReconnectMaxMs: 1000,
    wsReconnectJitterPct: 0.1,
    positionsUserConfigured: false
  },
  rpc: {
    rateLimitWindowMs: 1000,
    waitConfirmations: 1,
    waitTimeoutMs: 1000,
    providers: {
      alchemy: { rpcBaseUrl: 'http://localhost', wsBaseUrl: 'ws://localhost', apiKeyConfigured: false, rps: 1 },
      quicknode: { rpcBaseUrlConfigured: false, rps: 1 },
      chainstack: { rpcBaseUrl: 'http://localhost', wsBaseUrl: 'ws://localhost', rps: 1 },
      ankr: { rpcBaseUrl: 'http://localhost', rpsPhase1: 1, rpsPhase2: 1 },
      privateNode: { rpcBaseUrl: 'http://localhost', wsBaseUrl: 'ws://localhost', rps: 1 }
    }
  }
};

const schemaSnapshot = {
  version: 'test',
  sections: [
    { key: 'policy', label: 'Policy', fields: [] },
    { key: 'risk', label: 'Risk', fields: [] }
  ]
};

export type DashboardTestServer = {
  baseUrl: string;
  getAppliedProfile: () => string | null;
  close: () => Promise<void>;
};

export const startDashboardServer = (): Promise<DashboardTestServer> => {
  if (!existsSync(indexPath)) {
    throw new Error(`Missing dashboard build: ${indexPath}`);
  }

  let activeProfile = 'near_zero';
  let activeSource = 'defaults';
  let appliedProfile: string | null = null;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/config/schema') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(schemaSnapshot));
      return;
    }

    if (url === '/config/infra') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(infraSnapshot));
      return;
    }

    if (url === '/config/risk-profiles') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          activeProfile: activeProfile,
          activeProfileSource: activeSource,
          availableProfiles: ['near_zero', 'moderate', 'high', 'extra_high']
        })
      );
      return;
    }

    if (url === '/config/risk-profile' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let payload: { profile?: string } = {};
        try {
          payload = JSON.parse(body || '{}') as { profile?: string };
        } catch {
          payload = {};
        }
        if (payload.profile) {
          activeProfile = payload.profile;
          appliedProfile = payload.profile;
          activeSource = 'test';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            profile: { id: activeProfile, source: activeSource },
            policy: {},
            risk: {},
            persisted: true
          })
        );
      });
      return;
    }

    if (url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          policy: {},
          risk: {},
          riskProfile: activeProfile,
          riskProfileSource: activeSource,
          tradingMode: 'shadow',
          tradingEnabled: false
        })
      );
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', checks: {} }));
      return;
    }

    if (url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [] }));
      return;
    }

    if (url === '/slo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ aggregates: [] }));
      return;
    }

    if (url === '/incidents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    if (url === '/markets') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    if (url === '/positions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ positions: [] }));
      return;
    }

    if (url?.startsWith('/decisions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    if (url?.startsWith('/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('\n');
      res.end();
      return;
    }

    const normalized = url.startsWith('/') ? url : `/${url}`;
    const relative = normalized === '/' ? '/index.html' : normalized;
    const filePath = resolve(distDir, `.${relative}`);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = extname(filePath);
    const type = contentTypes[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(readFileSync(filePath));
  });

  return new Promise((resolvePromise) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}`,
        getAppliedProfile: () => appliedProfile,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          })
      });
    });
  });
};
