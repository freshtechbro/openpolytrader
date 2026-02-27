import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const localVenvPython = resolve(process.cwd(), 'services/ip-oracle/.venv/bin/python');
const PYTHON_BIN =
  process.env.IP_ORACLE_PYTHON_BIN?.trim() ||
  (existsSync(localVenvPython) ? localVenvPython : 'python3');

async function hasOracleSidecarPrerequisites(): Promise<boolean> {
  try {
    await execFileAsync(PYTHON_BIN, [
      '-c',
      'import fastapi, uvicorn; from ortools.sat.python import cp_model'
    ]);
    return true;
  } catch {
    return false;
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed_to_reserve_port'));
        return;
      }
      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Service likely still booting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('ip_oracle_sidecar_boot_timeout');
}

const hasPrerequisites = await hasOracleSidecarPrerequisites();
const describeIfReady = hasPrerequisites ? describe : describe.skip;

describeIfReady('IP oracle sidecar smoke', () => {
  let processRef: ChildProcessWithoutNullStreams | null = null;
  let baseUrl = '';
  const logs: string[] = [];

  beforeAll(async () => {
    const appPath = resolve(process.cwd(), 'services/ip-oracle/app.py');
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;

    processRef = spawn(PYTHON_BIN, [appPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IP_ORACLE_HOST: '127.0.0.1',
        IP_ORACLE_PORT: String(port),
        IP_ORACLE_LOG_LEVEL: 'warning'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    processRef.stdout.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString('utf8'));
    });
    processRef.stderr.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString('utf8'));
    });

    await waitForHealth(baseUrl, 20000);
  }, 30000);

  afterAll(async () => {
    const running = processRef;
    processRef = null;
    if (!running) return;
    if (running.exitCode !== null || running.signalCode !== null) return;

    running.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        if (running.exitCode === null && running.signalCode === null) {
          running.kill('SIGKILL');
        }
        resolveExit();
      }, 3000);

      running.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  });

  it('serves health and solves a feasible binary model', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { backend?: string; ok?: boolean };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.backend).toBe('ortools-cp-sat');

    const solve = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'smoke-feasible',
        timeLimitMs: 250,
        objective: {
          variables: ['x_a', 'x_b'],
          coefficients: [-0.02, -0.01],
          sense: 'min'
        },
        constraints: {
          type: 'linear_binary',
          rows: [{ coefficients: [1, 1], op: '<=', rhs: 1 }]
        },
        warmStartHint: {
          variables: ['x_a', 'x_b'],
          values: [1, 0]
        }
      })
    });
    expect(solve.status).toBe(200);
    const body = (await solve.json()) as {
      status: string;
      assignment?: Record<string, number>;
      runtimeMs: number;
      error?: string | null;
    };
    expect(['optimal', 'feasible']).toContain(body.status);
    expect(body.assignment?.x_a ?? body.assignment?.x_b).toBeDefined();
    expect(body.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(body.error ?? null).toBeNull();
  });

  it('returns infeasible status for contradictory constraints', async () => {
    const solve = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'smoke-infeasible',
        timeLimitMs: 250,
        objective: {
          variables: ['x_only'],
          coefficients: [1],
          sense: 'min'
        },
        constraints: {
          type: 'linear_binary',
          rows: [
            { coefficients: [1], op: '<=', rhs: 0 },
            { coefficients: [1], op: '>=', rhs: 1 }
          ]
        }
      })
    });

    if (!solve.ok) {
      throw new Error(`sidecar_http_${solve.status}: ${logs.join('\n').slice(0, 4000)}`);
    }

    const body = (await solve.json()) as { status: string };
    expect(body.status).toBe('infeasible');
  });
});
