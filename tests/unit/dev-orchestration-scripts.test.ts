import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const readScript = (relativePath: string): string => {
  const root = process.cwd();
  return readFileSync(path.join(root, relativePath), 'utf8');
};

describe('dev orchestration script guardrails', () => {
  it('requires backend readiness before treating startup and status as healthy', () => {
    const upSource = readScript('scripts/dev-up.sh');
    const statusSource = readScript('scripts/dev-status.sh');

    expect(upSource).toContain('BACKEND_READY_TIMEOUT_SECONDS="${OPS_BACKEND_READY_TIMEOUT_SECONDS:-45}"');
    expect(upSource).toContain('wait_for_backend_ready');
    expect(upSource).toContain('${OPS_BASE_URL}/health/ready');
    expect(statusSource).toContain('backend_ready_status=$(http_code "${OPS_BASE_URL}/health/ready" "$TOKEN")');
    expect(statusSource).toContain('if [[ "$backend_ready_status" != "200" ]]; then');
  });

  it('requires live pid+listener before accepting dashboard log fallback', () => {
    const source = readScript('scripts/dev-status.sh');

    expect(source).toContain('"$dashboard_log_ready" == "true" && "$dashboard_pid_alive" == "true" && "$dashboard_listener" == "true"');
  });

  it('retries dashboard readiness with bounded backoff before warning', () => {
    const source = readScript('scripts/dev-up.sh');

    expect(source).toContain('DASHBOARD_RETRY_ATTEMPTS="${OPS_DASHBOARD_READY_RETRY_ATTEMPTS:-2}"');
    expect(source).toContain('DASHBOARD_RETRY_BACKOFF_SECONDS="${OPS_DASHBOARD_READY_RETRY_BACKOFF_SECONDS:-1}"');
    expect(source).toContain('DASHBOARD_RETRY_WINDOW_SECONDS="${OPS_DASHBOARD_READY_RETRY_WINDOW_SECONDS:-2}"');
    expect(source).toContain('Dashboard readiness retry ${retry}/${DASHBOARD_RETRY_ATTEMPTS}');
    expect(source).toContain('Dashboard became ready after retry ${retry}/${DASHBOARD_RETRY_ATTEMPTS}.');
  });

  it('classifies stale pid state with listener-aware messaging in dev-down', () => {
    const source = readScript('scripts/dev-down.sh');

    expect(source).toContain('pid file is stale (pid $pid), but listener is active on port $port');
    expect(source).toContain('pid file missing, but listener is active on port $port');
    expect(source).toContain('pid file empty, but listener is active on port $port');
  });

  it('keeps lifecycle smoke deterministic with up/status/down/status sequence', () => {
    const source = readScript('scripts/dev-lifecycle-smoke.sh');

    expect(source).toContain('step=preclean');
    expect(source).toContain('step=start');
    expect(source).toContain('step=status_up');
    expect(source).toContain('step=down');
    expect(source).toContain('step=status_down_expected_fail');
    expect(source).toContain('EXPECT_DOWN_STATUS_EXIT_CODE');
  });
});
