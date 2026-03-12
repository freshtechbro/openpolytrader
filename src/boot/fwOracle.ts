import { setTimeout as delay } from 'node:timers/promises';

import type { TradingMode } from '../config/env.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import { buildBaseUrl, normalizeBaseUrlOverride, resolveBaseUrl } from '../utils/baseUrl.js';

const DEFAULT_FW_ORACLE_HOST = '127.0.0.1:7071';
const DEFAULT_FW_ORACLE_BASE_URL = buildBaseUrl('http:', DEFAULT_FW_ORACLE_HOST);

export function resolveFwOracleBaseUrl(value?: string): string {
  return resolveBaseUrl(DEFAULT_FW_ORACLE_BASE_URL, value);
}

function normalizeOracleBaseUrl(value: string | undefined): string {
  return (normalizeBaseUrlOverride(value) ?? '').replace(/\/+$/, '');
}

function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  timeoutHandle.unref?.();
  return fetch(url, { method: 'GET', headers, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

function buildOracleStartupError(healthUrl: string, attempts: number, lastFailure: string): Error {
  return new Error(
    `[boot] FW oracle sidecar is unavailable (${healthUrl}; attempts=${attempts}; last=${lastFailure}). Start the full stack with \`npm run dev:ops\` or bring up the oracle sidecar.`
  );
}

function recordOracleStartupFailure(
  metrics: Pick<MetricsStore, 'record'>,
  healthUrl: string,
  attempts: number,
  lastFailure: string
): void {
  metrics.record({
    type: 'incident',
    timestamp: Date.now(),
    data: {
      reason: 'fw_oracle_unavailable_startup',
      detail: { healthUrl, attempts, lastFailure }
    }
  });
}

export function ensureFwOracleStartupReady(input: {
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  attempts: number;
  retryDelayMs: number;
  metrics: Pick<MetricsStore, 'record'>;
}): Promise<void> {
  if (!input.tradingEnabled || input.tradingMode !== 'paper') {
    return Promise.resolve();
  }

  const baseUrl = normalizeOracleBaseUrl(input.baseUrl);
  if (!baseUrl) {
    return Promise.reject(
      new Error(
        '[boot] FW oracle base URL is empty in paper mode. Set FW_ORACLE_BASE_URL or use `npm run dev:ops`.'
      )
    );
  }

  const healthUrl = `${baseUrl}/health`;
  const headers: Record<string, string> = {};
  if (input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }

  const attempts = Math.max(1, input.attempts);
  const runAttempt = (attempt: number): Promise<void> =>
    fetchWithTimeout(healthUrl, input.timeoutMs, headers).then(
      (response) => {
        if (response.ok) {
          input.metrics.record({
            type: 'fw_oracle',
            timestamp: Date.now(),
            data: { event: 'startup_healthcheck_ok', healthUrl, attempt }
          });
          return;
        }
        const failure = `http_${response.status}`;
        if (attempt < attempts) {
          return delay(Math.max(50, input.retryDelayMs)).then(() => runAttempt(attempt + 1));
        }
        recordOracleStartupFailure(input.metrics, healthUrl, attempts, failure);
        return Promise.reject(buildOracleStartupError(healthUrl, attempts, failure));
      },
      (error) => {
        const failure = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) {
          return delay(Math.max(50, input.retryDelayMs)).then(() => runAttempt(attempt + 1));
        }
        recordOracleStartupFailure(input.metrics, healthUrl, attempts, failure);
        return Promise.reject(buildOracleStartupError(healthUrl, attempts, failure));
      }
    );

  return runAttempt(1);
}
