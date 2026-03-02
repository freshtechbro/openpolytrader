# Security Procedures

## Principles
- Never commit secrets (.env files, API keys, private keys).
- Prefer least privilege: ops API should be reachable only to operators.
- Assume logs and metrics may be aggregated; avoid leaking credentials.

## Secrets

The runtime reads secrets from environment variables (see `.env.example`).

Required for live trading (`TRADING_ENABLED=true` and `TRADING_MODE=live`):
- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER`

Optional alerts:
- `OPS_ALERT_WEBHOOK_URL` (treat as secret if it embeds tokens)

## Ops API authentication

If `OPS_API_TOKEN` is set, the ops API requires auth for operational routes.
Session bootstrap routes (`/ops/session`) remain reachable to establish/inspect session state.
Supported token locations:
- `Authorization: Bearer <token>`
- `x-ops-token: <token>`
- `?token=<token>`

## Key rotation

1. Generate a new key/secret in the provider dashboard.
2. Update the runtime environment (do not restart with trading enabled until verified).
3. Restart the service and confirm:
   - `/health` is reachable and returns expected checks
   - websocket connection stable
   - no auth failures in logs
4. Revoke the old key.

## Incident response

If you suspect credential leakage:
1. Disable trading (`TRADING_ENABLED=false` or `TRADING_MODE=off`) and stop the process.
2. Rotate keys immediately.
3. Review recent incidents and event logs for suspicious activity.
4. Re-deploy with new credentials and verify ops API auth.
