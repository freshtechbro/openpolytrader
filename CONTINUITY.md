Goal (incl. success criteria):
- Update all docs (README, AGENTS, and docs/ tree) to match current scripts/config/architecture, then commit and push to `main`.

Constraints/Assumptions:
- Follow AGENTS.md instructions (no stubs/placeholders, DRY, no destructive git commands, prefer `rg`).
- Only the main agent edits `CONTINUITY.md`; sub-agents append to `sub_continuity.md`.
- Approval policy is `never`; run needed commands directly and validate locally where useful.
- Begin replies with a brief Ledger Snapshot (Goal + Now/Next + Open Questions).
- Use RepoPrompt context builder before doc updates (completed).

Key decisions:
- Align defaults in docs to `.env.example` and `scripts/dev-up.sh`.
- Remove references to deleted docs and clarify signal agent presence.

State:
  - Done:
    - Updated README, AGENTS, architecture, setup, runbook, and config-knobs docs.
    - Committed and pushed documentation updates to `main`.
  - Now:
    - None.
  - Next:
    - None.

Open questions (UNCONFIRMED if needed):
  - None.

Working set (files/ids/commands):
- `README.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/Development/setup.md`
- `docs/Operations/runbook.md`
- `docs/Operations/config-knobs.md`
- `CONTINUITY.md`
- Commands: `rg`, `git status`

Key learnings:
- `.env.example` defaults: `TRADING_ENABLED=true`, `TRADING_MODE=shadow`, `RISK_PROFILE=extra_high`.
- `dev:ops` runs `scripts/dev-up.sh`, which enforces OPS token and runs the dashboard on port 5174 with `TRADING_MODE=paper`.
