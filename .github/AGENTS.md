# GitHub Workflows

## Scope
Applies to `.github/`.

## Responsibilities
- CI/CD workflow definitions and automation policy.
- Deterministic quality-gate execution for pull requests and pushes.

## Rules
- Keep workflow steps aligned with local gates: `lint`, `typecheck`, `build`, `test`, `test:coverage`.
- Prefer repository npm scripts over duplicated inline shell logic.
- Never hardcode secrets; use GitHub Actions secrets and env wiring.

## Validation
- Confirm workflow syntax remains valid after edits.
- Verify workflow command names match `package.json` scripts.
