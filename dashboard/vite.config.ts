import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DASHBOARD_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_OPS_PROXY_TARGET = 'http://localhost:3000';
export const OPS_PROXY_PATHS = [
  '/ops/session',
  '/stream',
  '/health',
  '/metrics',
  '/slo',
  '/allowlist',
  '/markets',
  '/incidents',
  '/portfolio',
  '/decisions',
  '/config'
] as const;

export function resolveOpsProxyTarget(value: string | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '') ?? '';
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized;
  }
  return DEFAULT_OPS_PROXY_TARGET;
}

export function createOpsProxyConfig(target: string): Record<string, ProxyOptions> {
  return Object.fromEntries(
    OPS_PROXY_PATHS.map((path) => [
      path,
      {
        target,
        changeOrigin: true
      }
    ])
  );
}

export function createDashboardViteConfig(target: string): UserConfig {
  const proxy = createOpsProxyConfig(target);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy
    },
    preview: {
      proxy
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, DASHBOARD_DIR, '');
  return createDashboardViteConfig(resolveOpsProxyTarget(env.VITE_OPS_BASE_URL));
});
