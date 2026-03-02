# Documentation

## Scope
Applies to `docs/` and all nested documentation files.

## Responsibilities
- Keep architecture, operations, setup, and testing docs in sync with runtime behavior.
- Maintain one canonical command reference for start/help/stop workflows.

## Rules
- Source technical claims from code and scripts in this repository.
- Keep command examples executable and current with `package.json`.
- Favor concise, high-signal wording; avoid speculative statements.

## Validation
- Reconcile docs with `npm run help` output and `scripts/` behavior.
- Update cross-links when adding new docs pages.
