# IP Oracle Sidecar (OR-Tools)

This service runs the adaptive Frank-Wolfe integer projection solve path outside the Node runtime.

## Endpoints

- `GET /health`
- `POST /solve`

`POST /solve` matches the TypeScript contract in `src/services/ip-oracle/IpOracleClient.ts`.

## Local Run

```bash
cd services/ip-oracle
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Default bind:

- Host: `127.0.0.1`
- Port: `7071`

## Environment

- `IP_ORACLE_HOST` default `127.0.0.1`
- `IP_ORACLE_PORT` default `7071`
- `IP_ORACLE_LOG_LEVEL` default `info`
- `IP_ORACLE_API_KEY` optional bearer token for `/solve`
- `IP_ORACLE_WORKERS` CP-SAT worker count (default `1`)
- `IP_ORACLE_MAX_REQUEST_BYTES` request size cap (default `65536`)

## Quick Smoke

```bash
curl -s http://127.0.0.1:7071/health | jq
```
