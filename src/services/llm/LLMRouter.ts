import type { LLMConfig as AppLLMConfig, LLMProviderConfig } from '../../config/llm.js';

import type { LLMAgentId, LLMProviderId } from './types.js';

export interface LLMProviderSelection {
  primaryId: LLMProviderId;
  fallbackId: LLMProviderId;
  primary: LLMProviderConfig;
  fallback: LLMProviderConfig;
}

export function selectProviders(config: AppLLMConfig, agent: LLMAgentId): LLMProviderSelection {
  const agentConfig = config.agents[agent];
  const primaryId = agentConfig.provider;

  const fallbackId: LLMProviderId =
    primaryId === config.primaryProvider ? config.fallbackProvider : config.primaryProvider;

  if (primaryId === fallbackId) {
    throw new Error(`Invalid LLM routing config: fallback provider equals primary for ${agent}`);
  }

  return {
    primaryId,
    fallbackId,
    primary: config.providers[primaryId],
    fallback: config.providers[fallbackId]
  };
}
