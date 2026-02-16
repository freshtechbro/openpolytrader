import { randomUUID } from 'node:crypto';

import type { EventStore } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';
import { LLMDecisionReasoningV1Schema, LLMDecisionRecordV1Schema } from '../../domain/llm.js';
import { sha256 } from '../../utils/crypto.js';
import { clamp01 } from '../../utils/math.js';
import type { LLMCallResult, LLMAgentId, LLMEndpoint, LLMMode, LLMProviderId, LLMRequest } from './types.js';

export interface LLMDecisionLoggerArgs {
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
  store?: EventStore;
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

  const errorPayload =
    args.call.error ??
    (args.call.status === 'disabled' ? { type: 'disabled', message: 'disabled' } : undefined);

  const reasoning = {
    provider: {
      provider_id: args.call.providerId ?? args.providerFallback.providerId,
      base_url: args.call.baseUrl ?? args.providerFallback.baseUrl,
      endpoint: args.call.endpoint ?? args.providerFallback.endpoint,
      model: args.call.model ?? args.providerFallback.model
    },
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
      max_output_tokens:
        args.request.endpoint === 'responses' ? args.request.max_output_tokens : args.request.max_tokens,
      response_format: args.request.endpoint === 'chat.completions' ? args.request.response_format : undefined
    },
    hashes: { prompt_hash: promptHash, context_hash: contextHash, prompt_version: args.promptVersion },
    usage: args.call.usage
      ? {
          input_tokens: args.call.usage.inputTokens,
          output_tokens: args.call.usage.outputTokens,
          total_tokens: args.call.usage.totalTokens
        }
      : undefined,
    result: {
      status:
        args.call.status === 'fallback'
          ? 'fallback'
          : args.call.status === 'timeout'
            ? 'timeout'
            : args.call.status === 'error' || args.call.status === 'disabled'
              ? 'error'
              : 'success',
      error: errorPayload
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
    messageBus.emit('llm:decision', {
      decision: decisionParsed.data,
      reasoning: reasoningParsed.data,
      at_ms: args.nowMs
    });
  }

  const decisionPayload = decisionParsed.success ? decisionParsed.data : decision;
  const reasoningPayload = reasoningParsed.success ? reasoningParsed.data : reasoning;
  args.store?.persistDecision({
    id: randomUUID(),
    subjectId: args.subject,
    timestampMs: args.nowMs,
    agent: args.agent,
    decisionJson: decisionPayload,
    reasoningJson: reasoningPayload
  });
}
