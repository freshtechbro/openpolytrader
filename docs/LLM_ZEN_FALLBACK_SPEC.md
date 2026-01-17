# OpenCode Zen Multi-Tier Fallback Spec

Date: 2026-01-17

## Objective

Define and document two-tier fallback behavior for OpenCode Zen (primary model -> retry -> backup model), with OpenRouter configured but hard-disabled by default.

## Non-goals

- No changes to trading logic or non-LLM systems.
- No paid or non-free OpenCode Zen models.
- No automatic OpenRouter usage unless explicitly enabled.

## Current State (from `.env.example`)

| Agent | Provider | Model |
| --- | --- | --- |
| ExecutionAgent | opencode-zen | grok-code |
| RiskAgent | opencode-zen | minimax-m2.1-free |
| ScannerAgent | opencode-zen | minimax-m2.1-free |
| LearningAgent | opencode-zen | minimax-m2.1-free |
| PortfolioAgent | opencode-zen | minimax-m2.1-free |
| MarketDataAgent | opencode-zen | minimax-m2.1-free |
| OpsAgent | opencode-zen | grok-code |

OpenRouter is configured as a fallback provider in config, but will be hard-disabled via `LLM_FALLBACK_ENABLED=false`.

## Requirements

1. **Primary attempt + retry**
   - Call the primary model.
   - If it fails, retry the primary model once (`LLM_PRIMARY_RETRY_COUNT=1`).

2. **Backup model**
   - If retry fails, attempt the backup model (OpenCode Zen free).
   - Backup model is per-agent and configurable.

3. **OpenRouter hard-disabled by default**
   - OpenRouter is only attempted if `LLM_FALLBACK_ENABLED=true`.

4. **Failure definition**
   - A failure includes timeout, error response, circuit-open, or empty/invalid output.

5. **Endpoint compatibility**
   - If primary uses `messages` (MiniMax) and backup uses `chat.completions`, convert request shape automatically.
   - If backup endpoint is `responses`, convert accordingly (future-proofing).

## Free OpenCode Zen Models (Docs)

OpenCode Zen lists the following free models and endpoints:
- **Grok Code Fast 1** (`grok-code`) — `chat.completions`
- **MiniMax M2.1** (`minimax-m2.1-free`) — `messages`
- **GLM 4.7** (`glm-4.7-free`) — `chat.completions`
- **Big Pickle** (`big-pickle`) — `chat.completions`
- **GPT-5 Nano** (`gpt-5-nano`) — `responses`

## Proposed Primary + Backup Mapping

**Rule:** Primary model gets 1 retry. If it still fails, switch to backup model. OpenRouter is not used unless explicitly enabled.

| Agent | Primary (Model/Endpoint) | Backup (Model/Endpoint) | Notes |
| --- | --- | --- | --- |
| ExecutionAgent | grok-code / chat | glm-4.7-free / chat | Same endpoint, easy switch |
| OpsAgent | grok-code / chat | glm-4.7-free / chat | Same endpoint, easy switch |
| RiskAgent | minimax-m2.1-free / messages | grok-code / chat | Requires messages -> chat conversion |
| ScannerAgent | minimax-m2.1-free / messages | grok-code / chat | Requires messages -> chat conversion |
| LearningAgent | minimax-m2.1-free / messages | grok-code / chat | Requires messages -> chat conversion |
| PortfolioAgent | minimax-m2.1-free / messages | grok-code / chat | Requires messages -> chat conversion |
| MarketDataAgent | minimax-m2.1-free / messages | grok-code / chat | Requires messages -> chat conversion |

Alternative (simpler): Use `glm-4.7-free` as backup for all agents (still `chat.completions`).

## Configuration (Env Vars)

Global:
- `LLM_FALLBACK_ENABLED=false`
- `LLM_PRIMARY_RETRY_COUNT=1`

Per-agent backup model + endpoint (endpoint optional; inferred from model if omitted):
- `LLM_EXECUTION_MODEL_BACKUP` / `LLM_EXECUTION_ENDPOINT_BACKUP`
- `LLM_RISK_MODEL_BACKUP` / `LLM_RISK_ENDPOINT_BACKUP`
- `LLM_SCANNER_MODEL_BACKUP` / `LLM_SCANNER_ENDPOINT_BACKUP`
- `LLM_LEARNING_MODEL_BACKUP` / `LLM_LEARNING_ENDPOINT_BACKUP`
- `LLM_PORTFOLIO_MODEL_BACKUP` / `LLM_PORTFOLIO_ENDPOINT_BACKUP`
- `LLM_MARKETDATA_MODEL_BACKUP` / `LLM_MARKETDATA_ENDPOINT_BACKUP`
- `LLM_OPS_MODEL_BACKUP` / `LLM_OPS_ENDPOINT_BACKUP`

Endpoint values:
- `chat.completions` (aliases: `chat`, `completions`)
- `messages`
- `responses`

## Endpoint Conversion Rules

When fallback switches from `messages` to `chat.completions`:

- `system` -> developer message
- Preserve user/assistant roles
- Preserve tool outputs (if present)

## Behavior Algorithm (Pseudo)

1. Attempt primary model.
2. If failure, retry primary (count = `LLM_PRIMARY_RETRY_COUNT`).
3. If still failing, attempt backup model (if configured).
4. Only if `LLM_FALLBACK_ENABLED=true`, attempt OpenRouter fallback.

## Observability

- Emit attempt counts and final model selection in LLM metrics.
- Capture failure reason in decisions log for each attempt.

## Test Flows

- Primary model fails -> retry -> backup succeeds.
- Primary model fails -> retry fails -> backup fails -> OpenRouter not attempted when disabled.
- messages -> chat conversion preserves roles and system message.
- Backup endpoint inferred correctly when not set.

## Definition of Done

- Spec and plan docs align on mapping, retries, and OpenRouter disablement.
- Config and runtime behavior can be implemented directly from this spec.
- Test flows are defined and traceable to code/tests.
