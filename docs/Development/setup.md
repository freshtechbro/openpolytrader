# Development Setup Spec

## Minimum Requirements

### Software

- Node.js 20+
- npm
- Git
- Optional: Docker (for `dev:live` / compose workflows)

### Required Configuration by Mode

#### Local safe mode (recommended)

- `TRADING_MODE=paper` or `TRADING_ENABLED=false`
- `OPS_API_TOKEN` in `.env`
- `VITE_OPS_API_TOKEN` in `dashboard/.env` (match `OPS_API_TOKEN`)

#### Live mode (strict required keys)

When `TRADING_ENABLED=true` and `TRADING_MODE=live`, runtime validation requires:

- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER`

## First-Time Setup

```bash
npm install
npm --prefix dashboard install
cp .env.example .env
cp dashboard/.env.example dashboard/.env
```

Set local-safe defaults before first run:

```bash
# .env
TRADING_MODE=paper
TRADING_ENABLED=true
OPS_API_TOKEN=replace-with-secure-token
```

```bash
# dashboard/.env
VITE_OPS_BASE_URL=http://localhost:3000
VITE_OPS_API_TOKEN=replace-with-secure-token
```

## Quickstart Modes

### Backend + Dashboard (recommended)

```bash
npm run dev:ops
```

Behavior:

- Requires an ops token (from env or dashboard env)
- Starts backend on `http://localhost:3000`
- Starts dashboard on `http://localhost:5174`
- Forces backend runtime to `TRADING_MODE=paper` in script startup
- Writes logs to `tmp/backend.log` and `tmp/dashboard.log`

Stop:

```bash
npm run dev:ops:down
```

### Backend Only

```bash
npm run dev
```

### Dashboard Only

```bash
npm --prefix dashboard run dev
```

### Docker backend + local dashboard

```bash
npm run dev:live
```

Stop:

```bash
npm run dev:live:down
```

## First-Run Verification

### Health check

```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

### Config check

```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/config
```

Confirm:

- `tradingMode` is `paper` (or your expected mode)
- dashboard loads at `http://localhost:5174`

## Quality Gate Commands

Run before PRs/releases:

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run test:coverage
npm --prefix dashboard run build
```

Optional UI e2e:

```bash
npm --prefix dashboard run test:e2e
```

## References

- Full env var inventory: `docs/Operations/environment-reference.md`
- Ops API: `docs/API.md`
- Runtime knobs: `docs/Operations/config-knobs.md`
- Operations procedures: `docs/Operations/runbook.md`
- Security controls: `docs/Operations/security.md`
