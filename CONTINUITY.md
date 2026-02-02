Goal (incl. success criteria):
- Clean up the `docs/` directory by removing plan/obsolete/unnecessary documents while keeping required docs intact and referenced, and ensure removals are reflected on the remote repo.

Constraints/Assumptions:
- Follow AGENTS.md instructions (no stubs/placeholders, DRY, no destructive git commands, prefer `rg`).
- Only the main agent edits `CONTINUITY.md`; sub-agents append to `sub_continuity.md`.
- Approval policy is `never`; run needed commands directly and validate locally where useful.
- Begin replies with a brief Ledger Snapshot (Goal + Now/Next + Open Questions).

Key decisions:
- Removed plan docs first, then removed spec, audit, and UI handoff docs per user request.

State:
  - Done:
    - Read `CONTINUITY.md` and `sub_continuity.md` for this repo.
    - Loaded continuity-ledger + ai-coding-framework skills for documentation hygiene.
    - Enumerated `docs/` contents via `rg --files docs`.
    - Deleted plan docs: `docs/EV_SIGNAL_IMPLEMENTATION_PLAN.md`, `docs/EV_SIGNAL_REMEDIATION_PLAN.md`, `docs/MARKET_CATALOG_REFRESH_PLAN.md`.
    - Deleted docs: `docs/EV_SIGNAL_SPEC.md`, `docs/Audits/AGENT_RISK_GATES_AUDIT_2026-01-13.md`, `docs/Audits/CONFIG_UI_AUDIT.md`, `docs/Development/dashboard-ui-handoff.md`.
    - Removed empty `docs/Audits` directory.
    - Removed references to the deleted UI handoff doc in `src/api/AGENTS.md`, `dashboard/src/AGENTS.md`, and `README.md`.
    - Verified remaining references only in continuity ledgers and checked git status.
  - Now:
    - Await direction on commit/push to ensure remote removal.
  - Next:
    - Commit deletions with a docs/cleanup message.
    - Push to the selected branch.

Open questions (UNCONFIRMED if needed):
  - Which branch should receive the deletions, and should I push after commit?

Working set (files/ids/commands):
- `CONTINUITY.md`
- `docs/`
- `src/api/AGENTS.md`
- `dashboard/src/AGENTS.md`
- `README.md`
- Commands: `rg --files docs`, `rg "docs/" -g"*.md"`, `git status`

Key learnings:
- None yet.
