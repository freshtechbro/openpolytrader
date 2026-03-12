import type { EventStore } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import { safeParseJSON } from '../../utils/serialization.js';
import { logLLMDecision } from './LLMDecisionLogger.js';
import type { LLMCallResult, LLMAgentId, LLMClientPort, LLMRequest } from './types.js';

export interface AgentPolicyHashes {
  tradePolicyHash: string;
  riskConfigHash: string;
}

export interface AgentLlmConfig<TAgent extends LLMAgentId> {
  config: AppLLMConfig;
  client: LLMClientPort<TAgent>;
  promptVersion: string;
  policyHashes: AgentPolicyHashes;
}

export interface AgentLlmContext<TAgent extends LLMAgentId> extends AgentLlmConfig<TAgent> {
  agent: TAgent;
}

type AgentJsonParseResult<TOutput> =
  | { success: true; data: TOutput }
  | { success: false };

interface AgentJsonSchema<TOutput> {
  safeParse(input: unknown): AgentJsonParseResult<TOutput>;
}

interface AgentJsonCallResult<TOutput> {
  call: LLMCallResult;
  parsed: unknown;
  validated: AgentJsonParseResult<TOutput>;
  missingOutput: boolean;
  violations: string[];
}

export function withAgent<TAgent extends LLMAgentId>(
  agent: TAgent,
  llm: AgentLlmConfig<TAgent>
): AgentLlmContext<TAgent> {
  return { agent, ...llm };
}

export async function callAgentJson<TAgent extends LLMAgentId, TOutput>(
  llm: AgentLlmContext<TAgent>,
  request: LLMRequest,
  schema: AgentJsonSchema<TOutput>,
  nowMs?: number
): Promise<AgentJsonCallResult<TOutput>> {
  const call = await llm.client.call(llm.agent, request, nowMs);
  const missingOutput = !call.outputText;
  const parsed = missingOutput ? null : safeParseJSON(call.outputText);
  const validated = missingOutput ? ({ success: false } as const) : schema.safeParse(parsed);

  return {
    call,
    parsed,
    validated,
    missingOutput,
    violations: missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output']
  };
}

type LogAgentDecisionArgs = Omit<
  Parameters<typeof logLLMDecision>[0],
  'agent' | 'promptVersion' | 'policyHashes' | 'providerFallback' | 'messageBus' | 'store'
> & {
  messageBus?: MessageBus<RuntimeEventMap>;
  store?: EventStore;
};

export function logAgentDecision<TAgent extends LLMAgentId>(
  llm: AgentLlmContext<TAgent>,
  args: LogAgentDecisionArgs
): void {
  const agentConfig = llm.config.agents[llm.agent];
  const provider = llm.config.providers[agentConfig.provider];

  logLLMDecision({
    ...args,
    agent: llm.agent,
    promptVersion: llm.promptVersion,
    policyHashes: llm.policyHashes,
    providerFallback: {
      providerId: agentConfig.provider,
      baseUrl: provider.baseUrl,
      endpoint: args.request.endpoint,
      model: args.request.model
    },
    messageBus: args.messageBus,
    store: args.store
  });
}
