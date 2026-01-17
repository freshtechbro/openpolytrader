# OpenCode Zen Multi-Tier Fallback Plan

Implement two-tier primary model fallback within OpenCode Zen and keep OpenRouter disabled by default.

---

## Overview

### Scope
- Add per-agent backup model configuration and a global fallback-enable flag.
- Implement primary retry -> backup model selection before any provider fallback.
- Add endpoint conversion when backup endpoint differs from primary (messages -> chat, responses).
- Update tests and docs; run live debug checks after implementation approval.

### Key decisions
- OpenRouter configured but disabled with `LLM_FALLBACK_ENABLED=false` by default.
- Primary model retry count = 1.
- Backup models are free OpenCode Zen models (grok-code for minimax group, glm-4.7-free for grok group).

---

## Task 1 — Add config + env surface for backup models and fallback flag

### Reasoning
We need an explicit, testable configuration for backup models and a hard switch to disable OpenRouter.

### What to do
Add env + config fields to represent backup models, backup endpoints (optional), and fallback enablement.

### How
1. Extend `src/config/env.ts` to add:
   - `LLM_FALLBACK_ENABLED` (boolean, default false)
   - `LLM_PRIMARY_RETRY_COUNT` (number, default 1)
   - `LLM_<AGENT>_MODEL_BACKUP` (string, optional)
   - `LLM_<AGENT>_ENDPOINT_BACKUP` (enum chat/messages/responses, optional)
2. Extend `src/config/llm.ts` to include these values in config shape.
3. Update `.env.example` to document new vars.

### Files impacted
- `src/config/env.ts`
- `src/config/llm.ts`
- `.env.example`

### End goal
Config exposes backup models and fallback-disable flag for all agents.

### Acceptance criteria
- [ ] Env schema validates new fields
- [ ] Config object includes backup model and retry settings
- [ ] `.env.example` documents new vars

---

## Task 2 — Implement primary retry + backup model selection

### Reasoning
We need deterministic multi-tier fallback within the same provider before ever calling OpenRouter.

### What to do
Add logic in `LLMClient` to attempt primary model, then retry once, then backup model.

### How
1. Add helper to clone an `LLMRequest` with a new model.
2. Add loop in `LLMClient.call()`:
   - Attempt primary model N times (N = 1 + retry count)
   - If all fail, attempt backup model (if configured)
3. Only after those attempts, call OpenRouter fallback **if** `LLM_FALLBACK_ENABLED` is true.

### Files impacted
- `src/services/llm/LLMClient.ts`
- `src/services/llm/LLMRouter.ts` (only if needed)

### End goal
Primary -> retry -> backup executes before any provider fallback.

### Acceptance criteria
- [ ] Backup model is used only after primary retry fails
- [ ] OpenRouter is skipped when disabled
- [ ] Attempt counts reflected in LLM metrics and decisions

---

## Task 3 — Add endpoint conversion for backup models

### Reasoning
MiniMax uses `messages`; backups use `chat.completions`, so fallback must convert request shapes.

### What to do
Convert `messages` requests to `chat.completions` (and `responses` if needed) when backup endpoint differs.

### How
1. Add converter in `LLMClient` (or helper module):
   - `system` -> developer message
   - `messages` preserve user/assistant roles
2. Use backup endpoint if specified; otherwise infer from model mapping.

### Files impacted
- `src/services/llm/LLMClient.ts`
- `src/services/llm/types.ts` (if helper types needed)

### End goal
Backup models can run even when endpoint differs.

### Acceptance criteria
- [ ] messages -> chat conversion covered by tests
- [ ] Backup calls succeed for minimax-based agents

---

## Task 4 — Tests for multi-tier fallback and disabled OpenRouter

### Reasoning
Failover logic is critical; tests prevent regressions and keep coverage above threshold.

### What to do
Extend unit tests to validate retry -> backup -> no OpenRouter when disabled.

### How
1. Add tests in `tests/unit/llm-services.test.ts`:
   - Primary failure -> retry -> backup model
   - Fallback provider skipped when `LLM_FALLBACK_ENABLED=false`
2. Add tests for endpoint conversion (messages -> chat).

### Files impacted
- `tests/unit/llm-services.test.ts`
- `tests/unit/llm-config.test.ts`

### End goal
Failover behavior is fully covered and passes coverage thresholds.

### Acceptance criteria
- [ ] Tests assert attempt order and model used
- [ ] Coverage >=95% overall

---

## Task 5 — Live validation + docs updates

### Reasoning
We must confirm behavior in runtime and document how to configure it.

### What to do
Run debug endpoints, confirm decisions output, and update docs.

### How
1. Run `/debug/*` endpoints and check `/decisions` for each agent.
2. Update `docs/LLM_ZEN_FALLBACK_SPEC.md` and `docs/LLM_PARSING_AND_DECISIONS_FLOW_REPORT.md` with final settings and results.

### Files impacted
- `docs/LLM_ZEN_FALLBACK_SPEC.md`
- `docs/LLM_PARSING_AND_DECISIONS_FLOW_REPORT.md`

### End goal
Runtime verified and documentation aligned.

### Acceptance criteria
- [ ] Decisions show success outputs per agent
- [ ] Docs reflect final config + validation

---

## File-by-file implementation sequence

1. `src/config/env.ts` — Task 1
2. `src/config/llm.ts` — Task 1
3. `.env.example` — Task 1
4. `src/services/llm/LLMClient.ts` — Tasks 2–3
5. `tests/unit/llm-services.test.ts` — Task 4
6. `tests/unit/llm-config.test.ts` — Task 4
7. `docs/LLM_ZEN_FALLBACK_SPEC.md` — Task 5
8. `docs/LLM_PARSING_AND_DECISIONS_FLOW_REPORT.md` — Task 5

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| none | - | No new deps required |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.1 | 2026-01-17 | Reformat to required plan template and align with spec |
| 1.0 | 2026-01-17 | Initial plan |

