# Development Scripts

## Scope
Applies to `scripts/`.

## Responsibilities
- Provide local development workflow automation (start/stop dev servers).
- Offer utility scripts for auth checks, smoke tests, and API credential derivation.

## Rules
- Scripts must be idempotent (safe to run multiple times).
- Use `set -euo pipefail` in bash scripts for strict error handling.
- Read configuration from environment variables or `.env` files.
- Keep PID files in `tmp/` for process management.

## Available Scripts

| Script | Purpose |
|--------|---------|
| `dev-up.sh` | Start backend + dashboard dev servers |
| `dev-down.sh` | Stop dev servers gracefully |
| `llmSmokeTest.ts` | Verify LLM service connectivity |
| `polymarketAuthCheck.ts` | Validate Polymarket API credentials |
| `polymarketDeriveApiCreds.ts` | Derive API credentials from private key |
| `polymarketLiveCheck.ts` | Test live Polymarket connectivity |

## Usage

```bash
# Start development environment
./scripts/dev-up.sh

# Stop development environment
./scripts/dev-down.sh

# Run smoke tests
npx tsx scripts/llmSmokeTest.ts
```
