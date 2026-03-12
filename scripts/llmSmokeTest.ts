import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { loadEnv } from '../src/config/env.js';
import { loadLLMConfig } from '../src/config/llm.js';
import { DEFAULT_RISK_CONFIG } from '../src/config/risk.js';
import { DEFAULT_TRADE_POLICY } from '../src/config/policy.js';
import { EventStore } from '../src/core/EventStore.js';
import { MetricsStore } from '../src/telemetry/metrics.js';
import { LLMClient } from '../src/services/llm/LLMClient.js';
import type { LLMAgentId, LLMMode, LLMRequest } from '../src/services/llm/types.js';
import { logLLMDecision } from '../src/services/llm/LLMDecisionLogger.js';
import { safeParseJSON } from '../src/utils/serialization.js';
import { writeCliFailure } from '../src/utils/cliFailure.js';
import { sha256 } from '../src/utils/crypto.js';
import { runCliMain } from './lib/runCli.js';

type SmokeTarget = {
  agent: LLMAgentId;
  buildRequest: (model: string) => LLMRequest;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function jsonChatRequest(model: string): LLMRequest {
  return {
    endpoint: 'chat.completions',
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'developer', content: 'Return JSON only: {"ok":true}. No prose.' },
      { role: 'user', content: '{"task":"smoke"}' }
    ]
  };
}

function jsonMessagesRequest(model: string): LLMRequest {
  return {
    endpoint: 'messages',
    model,
    system: 'Return JSON only: {"ok":true}. No prose.',
    messages: [{ role: 'user', content: '{"task":"smoke"}' }],
    temperature: 0,
    max_tokens: 200
  };
}

const TARGETS: SmokeTarget[] = [
  { agent: 'ExecutionAgent', buildRequest: jsonChatRequest },
  { agent: 'RiskAgent', buildRequest: jsonChatRequest },
  { agent: 'ScannerAgent', buildRequest: jsonChatRequest },
  { agent: 'LearningAgent', buildRequest: jsonMessagesRequest },
  { agent: 'PortfolioAgent', buildRequest: jsonChatRequest },
  { agent: 'MarketDataAgent', buildRequest: jsonChatRequest },
  { agent: 'OpsAgent', buildRequest: jsonChatRequest }
];

export async function main(): Promise<void> {
  const env = loadEnv();
  const llmConfig = loadLLMConfig(env);
  const store = new EventStore({ dbPath: env.EVENT_STORE_PATH });
  const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);
  const llm = new LLMClient(llmConfig, { metrics });

  const policyHashes = {
    tradePolicyHash: sha256(stableStringify(DEFAULT_TRADE_POLICY)),
    riskConfigHash: sha256(stableStringify(DEFAULT_RISK_CONFIG))
  };

  const nowMs = Date.now();
  const results: Array<{ agent: LLMAgentId; status: string; providerId: string | null; endpoint: string | null; model: string | null }> = [];

  for (const target of TARGETS) {
    const agentConfig = llmConfig.agents[target.agent];
    const request = target.buildRequest(agentConfig.model);
    const call = await llm.call(target.agent, request, Date.now());
    const parsed = safeParseJSON(call.outputText);
    const mode = agentConfig.mode as LLMMode;

    logLLMDecision({
      agent: target.agent,
      mode,
      task: 'smoke_test',
      subject: `system:smoke:${target.agent}:${randomUUID()}`,
      baseline: { endpoint: request.endpoint, model: request.model },
      output: parsed ?? { raw: call.outputText },
      confidence: parsed ? 1 : 0,
      applied: false,
      clamp: { raw: call.outputText, parsed },
      nowMs: Date.now(),
      call,
      request,
      promptEnvelopeForHash: { task: 'smoke_test', agent: target.agent, request },
      contextForHash: { request },
      promptVersion: 'smoke-v1',
      policyHashes,
      providerFallback: {
        providerId: agentConfig.provider,
        baseUrl: llmConfig.providers[agentConfig.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      store
    });

    results.push({
      agent: target.agent,
      status: call.status,
      providerId: call.providerId,
      endpoint: call.endpoint,
      model: call.model
    });
  }

  console.log('LLM smoke ok', { enabled: llmConfig.enabled, results, at_ms: nowMs });
}

runCliMain(import.meta.url, main, (error) => {
  writeCliFailure('LLM smoke failed', error);
  process.exitCode = 1;
});
