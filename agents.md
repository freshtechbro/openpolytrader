# Continuity Ledger (compaction-safe)
Maintain a single Continuity Ledger for this workspace in `CONTINUITY.md`. The ledger is the canonical session briefing designed to survive context compaction; do not rely on earlier chat text unless it's reflected in the ledger.

## How it works
- At the start of every assistant turn: read `CONTINUITY.md`, update it to reflect the latest goal/constraints/decisions/state, then proceed with the work.
- Update `CONTINUITY.md` again whenever any of these change: goal, constraints/assumptions, key decisions, progress state (Done/Now/Next), or important tool outcomes.
- Keep it short and stable: facts only, no transcripts. Prefer bullets. Mark uncertainty as `UNCONFIRMED` (never guess).
- If you notice missing recall or a compaction/summary event: refresh/rebuild the ledger from visible context, mark gaps `UNCONFIRMED`, ask up to 1-5 targeted questions, then continue.

## `todowrite` vs the Ledger
- `todowrite` is for short-term execution scaffolding while you work (a small 3-7 step plan with pending/in_progress/completed).
- `todoread` is for checking the current task plan state.
- `CONTINUITY.md` is for long-running continuity across compaction (the "what/why/current state"), not a step-by-step task list.
- Keep them concise and consistent: when the plan or state changes, update the ledger at the intent/progress level (not every micro-step).

## In replies
- Begin with a brief "Ledger Snapshot" (Goal + Now/Next + Open Questions and recommended options based on your understanding, research and best practice). Print the full ledger only when it materially changes or when the user asks.

## `CONTINUITY.md` format (keep headings)
Goal (incl. success criteria):
- Constraints/Assumptions:
- Key decisions:
- State:
  - Done:
  - Now:
  - Next: at least 4 next tasks/subtasks each with a brief description. must be detailed with a clear action item and expected outcome and files to be impacted
- Open questions (UNCONFIRMED if needed):
  - When you have open questions, do your research in the codebase (and on the internet for best practices) to understand the existing patterns and constraints. Choose answers that are consistent with the existing patterns and constraints and best-practice and research all synchronized into logical recommendations. You must research codebase + external sources first, state the recommended option with brief rationale, and explicitly list any items that still require user input.
- Working set (files/ids/commands):


## Implementation Plan Format

When creating detailed implementation plans, use this standardized task-by-task format. This ensures plans are actionable, traceable, and can be handed off to any agent for execution.

### Plan Document Structure

```markdown
# [Plan Title]

[Brief description of what this plan covers]

---

## Overview

### [Context heading, e.g., "Distribution channels" or "Scope"]
- Bullet points summarizing key aspects

### Key decisions
- Decision 1
- Decision 2

---

## Task N — [Task Title]

### Reasoning
[Why this task is necessary. What problem it solves or what value it adds.]

### What to do
[One-sentence summary of the task objective.]

### How
1. Step-by-step instructions
2. Be specific about what to change
3. Include code snippets or commands where helpful

### Files impacted
- `path/to/file1.ts`
- `path/to/file2.ts`
- `path/to/new-file.ts` (new file)

### End goal
[What success looks like when this task is complete.]

### Acceptance criteria
- [ ] Criterion 1 (testable/verifiable)
- [ ] Criterion 2
- [ ] Criterion 3

---

## File-by-file implementation sequence

[Optional section listing the order in which files should be modified to minimize conflicts]

1. `file1.ts` — Tasks 1, 3
2. `file2.ts` — Task 2
3. `new-file.ts` — Task 4 (new file)

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| `package-name` | `^1.0.0` | Brief purpose |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | YYYY-MM-DD | Initial plan |
| 1.1 | YYYY-MM-DD | Added tasks X-Y for [reason] |
```

### Task Section Requirements

Each task MUST include all of these sections:

| Section | Purpose |
|---------|---------|
| **Reasoning** | Explains WHY this task matters (context for the implementer) |
| **What to do** | One-sentence summary of the objective |
| **How** | Numbered step-by-step instructions |
| **Files impacted** | Explicit list of files to create/modify |
| **End goal** | Success state description |
| **Acceptance criteria** | Checkbox list of verifiable conditions |

### Best Practices

1. **Atomic tasks**: Each task should be independently completable
2. **Clear sequencing**: If tasks have dependencies, document the order
3. **Testable criteria**: Acceptance criteria must be verifiable (not vague)
4. **File-first thinking**: Always list impacted files explicitly
5. **New files marked**: Indicate `(new file)` for files that don't exist yet
6. **Version the plan**: Track changes in the version history table

### Example Task

```markdown
## Task 4 — Replace JSONC parsing with robust parser

### Reasoning
Regex stripping breaks valid JSONC strings containing `//` and doesn't support trailing commas.

### What to do
Use `jsonc-parser` in `src/config.ts` and strengthen tests.

### How
1. Add dependency: `jsonc-parser`
2. Replace regex comment stripping with `jsonc-parser`'s parse function
3. Add tests for `http://` strings and trailing commas

### Files impacted
- `package.json` (new dependency)
- `src/config.ts`
- `tests/config.test.ts`

### End goal
JSONC works reliably for real-world configs.

### Acceptance criteria
- [ ] Tests pass for trailing commas and URLs with `//`
- [ ] No regressions in config parsing
```

### When to Create Implementation Plans

Create a formal implementation plan when:
- Task involves 3+ files or 3+ distinct changes
- Multiple agents may work on the task
- Task spans multiple sessions or may be interrupted
- User requests a detailed plan before implementation
- Release, migration, or refactoring work

Save implementation plans to `docs/` with descriptive names (e.g., `docs/RELEASE_PLAN.md`, `docs/MIGRATION_PLAN.md`).

## Commit and PR Guidance

### Atomic Commit Workflow

When committing changes, follow this workflow to create clean, reviewable history:

1. **Group changes by impact and similarity**:
   | Group Type | Example Prefix | Description |
   |------------|----------------|-------------|
   | Feature | `feat:` | New functionality (CLI, tools, skills) |
   | Fix | `fix:` | Bug fixes, error handling improvements |
   | Test | `test:` | Test additions or coverage improvements |
   | Docs | `docs:` | Documentation changes |
   | Chore | `chore:` | Cleanup, refactoring, config changes |

2. **Commit order** (dependencies first):
   - Core infrastructure changes first (config, types)
   - Feature implementations second
   - Tests third (they depend on features)
   - Documentation fourth
   - Cleanup/chore last

3. **Commit message format** (Conventional Commits):
   ```
   <type>: <short summary>

   - Bullet point details
   - What was added/changed/fixed
   - Why (if not obvious)
   ```

4. **Grouping rules**:
   - Group files that change together for the same reason
   - Keep related test files with their implementation OR in a separate test commit
   - Never mix unrelated changes in one commit
   - Each commit should be independently reviewable

5. **Before committing**:
   - Run `npm run lint` - fix any errors
   - Run `npm run build` - ensure compilation succeeds
   - Run `npm run test` - ensure all tests pass
   - Check `git status` to review what will be committed

6. **Example atomic commit sequence**:
   ```
   feat: add CLI installer with jarvis-mcp pattern
   feat: extend skill system with multi-skill discovery
   feat: add task-specific skill packs
   test: add comprehensive test coverage for skill system
   docs: add CLI and skill system documentation
   chore: clean up obsolete docs and update state
   ```

### PR Guidance
- PRs should include summary, test notes, and extension screenshots if relevant.
- For releases, update `README.md` and related docs before publishing.

