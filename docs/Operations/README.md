# Operations Documentation Index

Use this folder for runtime operations, controls, and incident handling.

## Start Here

- Runbook: `docs/Operations/runbook.md`
- Operator strategy report: `docs/Operations/operator-strategy-report.md`
- Command reference: `docs/Development/commands.md`
- Environment reference (minimum requirements + all keys): `docs/Operations/environment-reference.md`
- Runtime config knobs: `docs/Operations/config-knobs.md`
- Security guidance: `docs/Operations/security.md`
- Full API endpoints: `docs/API.md`

## Live Trading Checklist

1. Configure required live keys:
   - `ALCHEMY_API_KEY`
   - `POLYMARKET_API_KEY`
   - `POLYMARKET_API_SECRET`
   - `POLYMARKET_PASSPHRASE`
   - `POLYMARKET_POSITIONS_USER`
2. Verify connectivity to:
   - `POLYMARKET_CLOB_BASE_URL`
   - `POLYMARKET_WS_URL`
   - `POLYMARKET_USER_WS_URL`
   - `POLYMARKET_DATA_API_BASE_URL`
3. Confirm auth and health:
   - `GET /health`
   - `GET /health/ready`
   - `GET /config`
4. Enable live mode only with explicit confirmation:
   - `POST /config/trading-mode?confirm=true`

## Recommended Local Safe Mode

- `TRADING_MODE=paper`
- `TRADING_ENABLED=true`
- `OPS_API_TOKEN` set
- Runtime session login on `/ops/*`
