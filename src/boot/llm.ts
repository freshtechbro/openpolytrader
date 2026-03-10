import { createDependencyLLMExtractor } from '../agents/dependency/DependencyLLMExtractor.js';
import { ExecutionAdvisor } from '../agents/execution/ExecutionAdvisor.js';
import { RiskAdvisor } from '../agents/risk/RiskAdvisor.js';
import type { Env } from '../config/env.js';
import { loadLLMConfig } from '../config/llm.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { EventStore } from '../core/EventStore.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import type { SupervisorLLMContext, SupervisorPolicyHashes } from '../core/supervisorAssembly.js';
import { LLMClient } from '../services/llm/LLMClient.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import { sha256 } from '../utils/crypto.js';

const LLM_PROMPT_VERSION = 'llm-v1';

export function createLLMBootstrap(input: {
  env: Env;
  policy: TradePolicy;
  risk: RiskConfig;
  metrics: MetricsStore;
  store: EventStore;
  messageBus: MessageBus<RuntimeEventMap>;
}) {
  const llmConfig = loadLLMConfig(input.env);
  const policyHashes = createPolicyHashes(input.policy, input.risk);
  const llmClient = new LLMClient(llmConfig, { metrics: input.metrics });
  const llmFacade: SupervisorLLMContext = {
    config: llmConfig,
    client: llmClient,
    promptVersion: LLM_PROMPT_VERSION,
    policyHashes
  };

  return {
    llmConfig,
    policyHashes,
    llmFacade,
    fwDependencyLlmExtractor: createDependencyLLMExtractor({
      llmConfig,
      llmClient,
      promptVersion: LLM_PROMPT_VERSION,
      policyHashes,
      messageBus: input.messageBus,
      eventStore: input.store,
      metrics: input.metrics
    }),
    executionAdvisor:
      llmConfig.enabled && llmConfig.agents.ExecutionAgent.mode !== 'disabled'
        ? new ExecutionAdvisor({ enabled: true, messageBus: input.messageBus })
        : undefined,
    riskAdvisor:
      llmConfig.enabled && llmConfig.agents.RiskAgent.mode !== 'disabled'
        ? new RiskAdvisor(
            {
              config: llmConfig,
              client: llmClient,
              promptVersion: LLM_PROMPT_VERSION,
              policyHashes,
              messageBus: input.messageBus,
              store: input.store,
              metrics: input.metrics
            }
          )
        : undefined
  };
}

export function refreshLLMPolicyHashes(
  policyHashes: SupervisorPolicyHashes,
  policy: TradePolicy,
  risk: RiskConfig
): void {
  const next = createPolicyHashes(policy, risk);
  policyHashes.tradePolicyHash = next.tradePolicyHash;
  policyHashes.riskConfigHash = next.riskConfigHash;
}

function createPolicyHashes(policy: TradePolicy, risk: RiskConfig): SupervisorPolicyHashes {
  return {
    tradePolicyHash: sha256(stableStringify(policy)),
    riskConfigHash: sha256(stableStringify(risk))
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => normalizeForStableStringify(item));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = normalizeForStableStringify(record[key]);
    }
    return out;
  }
  return value;
}
