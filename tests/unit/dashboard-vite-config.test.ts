import { describe, expect, it } from 'vitest';

import {
  OPS_PROXY_PATHS,
  createDashboardViteConfig,
  resolveOpsProxyTarget
} from '../../dashboard/vite.config';

describe('dashboard vite config', () => {
  it('defaults the local ops proxy target when no absolute base url is configured', () => {
    expect(resolveOpsProxyTarget(undefined)).toBe('http://localhost:3000');
    expect(resolveOpsProxyTarget('')).toBe('http://localhost:3000');
    expect(resolveOpsProxyTarget('/ops')).toBe('http://localhost:3000');
  });

  it('normalizes absolute ops proxy targets', () => {
    expect(resolveOpsProxyTarget('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(resolveOpsProxyTarget('https://ops.example.com///')).toBe('https://ops.example.com');
  });

  it('proxies the dashboard api routes for both dev and preview servers', () => {
    const config = createDashboardViteConfig('http://localhost:3000');
    const serverProxy = config.server?.proxy;
    const previewProxy = config.preview?.proxy;

    expect(serverProxy).toBeDefined();
    expect(previewProxy).toBeDefined();

    for (const path of OPS_PROXY_PATHS) {
      expect(serverProxy).toHaveProperty(path);
      expect(previewProxy).toHaveProperty(path);
      expect((serverProxy as Record<string, { target: string }>)[path].target).toBe(
        'http://localhost:3000'
      );
      expect((previewProxy as Record<string, { target: string }>)[path].target).toBe(
        'http://localhost:3000'
      );
    }

    expect(serverProxy).not.toHaveProperty('/ops');
    expect(previewProxy).not.toHaveProperty('/ops');
  });
});
