import { randomUUID } from 'node:crypto';

import type { DecisionStore, StoredDecisionRecord } from '../../core/EventStore.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { LLMDecisionReasoningV1Schema, LLMDecisionRecordV1Schema } from '../../domain/llm.js';
import { sha256 } from '../../utils/crypto.js';
import { clamp01 } from '../../utils/math.js';
import type { LLMCallResult, LLMAgentId, LLMEndpoint, LLMMode, LLMProviderId, LLMRequest } from './types.js';

interface LLMDecisionLoggerArgs {
  agent: LLMAgentId;
  mode: LLMMode;
  task: string;
  subject: string;
  baseline: unknown;
  output: unknown;
  confidence: number;
  applied: boolean;
  clamp: unknown;
  ttlMs?: number;
  nowMs: number;
  call: LLMCallResult;
  request: LLMRequest;
  promptEnvelopeForHash: unknown;
  contextForHash: unknown;
  promptVersion: string;
  policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  providerFallback: {
    providerId: LLMProviderId;
    baseUrl: string;
    endpoint: LLMEndpoint;
    model: string;
  };
  messageBus?: MessageBus<RuntimeEventMap>;
  store?: DecisionStore;
}

export function logLLMDecision(args: LLMDecisionLoggerArgs): void {
  const decision = {
    schema_version: 1,
    agent: args.agent,
    mode: args.mode,
    task: args.task,
    subject: args.subject,
    baseline: args.baseline,
    output: args.output,
    confidence: clamp01(args.confidence),
    applied: args.applied,
    clamp: args.clamp,
    ttl_ms: typeof args.ttlMs === 'number' ? args.ttlMs : undefined
  };

  const promptHash = sha256(JSON.stringify(args.promptEnvelopeForHash));
  const contextHash = sha256(JSON.stringify(args.contextForHash));

  const reasoning = {
    provider: buildProviderPayload(args),
    request_identity: {
      request_id_header: args.call.requestIdHeader,
      request_id_body: args.call.requestIdBody,
      response_id: args.call.responseId,
      correlation_id: undefined,
      attempt: args.call.attempt,
      fallback_reason: args.call.fallbackReason
    },
    timing: {
      started_at_ms: args.call.startedAtMs,
      latency_ms: Math.max(Math.floor(args.call.latencyMs), 0),
      timeout_ms: args.call.timeoutMs,
      max_retries: args.call.maxRetries
    },
    params: {
      temperature: args.request.temperature,
      top_p: args.request.top_p,
      max_output_tokens: getRequestMaxOutputTokens(args.request),
      response_format: getChatResponseFormat(args.request)
    },
    hashes: { prompt_hash: promptHash, context_hash: contextHash, prompt_version: args.promptVersion },
    usage: buildUsagePayload(args.call),
    result: {
      status: getReasoningStatus(args.call),
      error: getErrorPayload(args.call)
    },
    policy_snapshots: {
      trade_policy_hash: args.policyHashes.tradePolicyHash,
      risk_config_hash: args.policyHashes.riskConfigHash
    },
    data_export: { included_trade_details: false, redaction_applied: true }
  };

  const decisionParsed = LLMDecisionRecordV1Schema.safeParse(decision);
  const reasoningParsed = LLMDecisionReasoningV1Schema.safeParse(reasoning);

  if (decisionParsed.success && reasoningParsed.success) {
    args.messageBus?.emit('llm:decision', {
      decision: decisionParsed.data,
      reasoning: reasoningParsed.data,
      at_ms: args.nowMs
    });
  }

  const decisionPayload = decisionParsed.success ? decisionParsed.data : decision;
  const reasoningPayload = reasoningParsed.success ? reasoningParsed.data : reasoning;
  const record: StoredDecisionRecord = {
    id: randomUUID(),
    subjectId: args.subject,
    timestampMs: args.nowMs,
    agent: args.agent,
    decisionJson: decisionPayload,
    reasoningJson: reasoningPayload
  };
  args.store?.persistDecision(record);
}

function buildProviderPayload(args: LLMDecisionLoggerArgs) {
  return {
    provider_id: args.call.providerId ?? args.providerFallback.providerId,
    base_url: args.call.baseUrl ?? args.providerFallback.baseUrl,
    endpoint: args.call.endpoint ?? args.providerFallback.endpoint,
    model: args.call.model ?? args.providerFallback.model
  };
}

function getRequestMaxOutputTokens(request: LLMRequest): number | undefined {
  return request.endpoint === 'responses' ? request.max_output_tokens : request.max_tokens;
}

function getChatResponseFormat(request: LLMRequest) {
  return request.endpoint === 'chat.completions' ? request.response_format : undefined;
}

function buildUsagePayload(call: LLMCallResult) {
  if (!call.usage) return undefined;
  return {
    input_tokens: call.usage.inputTokens,
    output_tokens: call.usage.outputTokens,
    total_tokens: call.usage.totalTokens
  };
}

function getReasoningStatus(call: LLMCallResult): 'success' | 'fallback' | 'timeout' | 'error' {
  switch (call.status) {
    case 'fallback':
      return 'fallback';
    case 'timeout':
      return 'timeout';
    case 'error':
    case 'disabled':
      return 'error';
    default:
      return 'success';
  }
}

function getErrorPayload(call: LLMCallResult) {
  if (call.error) return call.error;
  if (call.status === 'disabled') {
    return { type: 'disabled', message: 'disabled' };
  }
  return undefined;
}
