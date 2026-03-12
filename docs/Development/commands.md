# Command Reference

Canonical command inventory for local development, operations, and diagnostics.

Primary source of truth:
- `package.json` scripts
- `scripts/help.sh`
- `dashboard/package.json` scripts

Related tooling/config references:
- `package-lock.json`, `dashboard/package-lock.json` (lockfiles used by `npm ci` and Docker builds)
- `tsconfig.json`, `dashboard/tsconfig.json` (typecheck/build contracts)
- `.eslintrc.cjs` (backend lint rules)
- `Dockerfile` (production backend image build + `/health/live` healthcheck)

## Help Commands

```bash
npm run help
npm run h
```

## Start Commands

```bash
# backend only
npm run dev

# full local paper stack (oracle + backend + dashboard)
npm run dev:ops
npm run dev:up
npm run paper:up

# health/status for full stack
npm run dev:ops:status
npm run paper:status

# deterministic lifecycle smoke
npm run dev:ops:smoke
npm run paper:smoke

# docker backend + local dashboard dev server
npm run dev:live

# production runtime (after build)
npm run start
```

## Stop / Kill Commands

```bash
# stop local paper stack
npm run dev:ops:down
npm run paper:down

# stop docker stack
npm run dev:live:down
```

`npm run dev:ops:down` behavior:
- sends `SIGTERM` to tracked process groups,
- escalates to `SIGKILL` when needed,
- performs best-effort port cleanup (`3000`, `5174`, `7071`).

Manual fallback process kill (only when PID tracking is stale):

```bash
lsof -ti tcp:3000,tcp:5174,tcp:7071 | xargs kill
```

## Root NPM Scripts

| Script | Description |
| --- | --- |
| `npm run help` | Print root command/tool/flag reference |
| `npm run h` | Alias for `npm run help` |
| `npm run postinstall` | Rebuild architecture-specific `esbuild` binaries |
| `npm run dev` | Start backend only via `tsx src/main.ts` |
| `npm run dev:ops` | Start oracle + backend + dashboard (paper mode) |
| `npm run dev:up` | Alias for `dev:ops` |
| `npm run dev:ops:down` | Stop local dev:ops processes |
| `npm run dev:ops:status` | Health-check oracle/backend/dashboard |
| `npm run dev:ops:smoke` | Deterministic lifecycle smoke (`up -> status -> down -> status`) |
| `npm run paper:up` | Alias for `dev:ops` |
| `npm run paper:down` | Alias for `dev:ops:down` |
| `npm run paper:status` | Alias for `dev:ops:status` |
| `npm run paper:smoke` | Alias for `dev:ops:smoke` |
| `npm run dev:live` | Start Docker backend plus local dashboard dev server |
| `npm run dev:live:down` | Stop Docker backend services |
| `npm run build` | Compile backend TypeScript |
| `npm run build:all` | Build backend + dashboard + Docker images |
| `npm run build:all:up` | Build all artifacts and start Docker services |
| `npm run build:all:live` | Build all artifacts and run `dev:live` |
| `npm run prestart` | Preflight market-catalog freshness before start |
| `npm run start` | Run compiled backend from `dist/main.js` |
| `npm run lint` | ESLint with zero warnings |
| `npm run typecheck` | TypeScript no-emit check |
| `npm run test` | Run Vitest suite |
| `npm run test:coverage` | Run Vitest with coverage thresholds |
| `npm run polymarket:check` | CLOB + WS connectivity smoke check |
| `npm run polymarket:authcheck` | Validate Polymarket auth credentials |
| `npm run polymarket:derive-creds` | Derive CLOB credentials from L1 key material |
| `npm run llm:smoke` | Smoke-test configured LLM routing |
| `npm run catalog:refresh:dev` | Run TS market-catalog generator directly |
| `npm run catalog:refresh` | Run compiled JS market-catalog generator |
| `npm run catalog:relations:dev` | Build dependency relation catalog via TS entrypoint |
| `npm run catalog:relations` | Build dependency relation catalog via compiled JS entrypoint |

`npm run dev:ops` startup gating:
- Oracle health and backend `/health/ready` are required.
- Dashboard probe timeout is a warning (non-fatal); re-check with `npm run dev:ops:status`.
- Backend readiness wait is bounded by `OPS_BACKEND_READY_TIMEOUT_SECONDS` (default `45`).
- `npm run dev:ops:status` only accepts dashboard log readiness when PID and listener checks are also live.
- After initial dashboard timeout, `dev:ops` runs short bounded retry/backoff probes before warning.

`npm run dev:ops:smoke` lifecycle contract:
- Runs preclean `down` first.
- Runs `up`, then `status` (must pass).
- Runs `down`, then `status` again (must fail with expected down-state exit code).

## Dashboard Scripts

```bash
npm --prefix dashboard run dev
npm --prefix dashboard run build
npm --prefix dashboard run test:e2e
```

## Common Gate Chain

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run test:coverage
npm --prefix dashboard run build
npm --prefix dashboard run test:e2e
```
