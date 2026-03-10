import type { LLMCallErrorInfo } from '../../domain/llm.js';

export type LLMProviderId = 'opencode-zen' | 'openrouter';

export type LLMAgentId =
  | 'ExecutionAgent'
  | 'RiskAgent'
  | 'ScannerAgent'
  | 'LearningAgent'
  | 'PortfolioAgent'
  | 'MarketDataAgent'
  | 'OpsAgent';

export type LLMMode = 'disabled' | 'shadow' | 'advisory' | 'active';

export type LLMEndpoint = 'chat.completions' | 'responses' | 'messages';

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type LLMCallError = LLMCallErrorInfo;

export interface LLMCallResult {
  status: 'success' | 'fallback' | 'timeout' | 'error' | 'disabled';
  providerId: LLMProviderId | null;
  baseUrl: string | null;
  endpoint: LLMEndpoint | null;
  model: string | null;
  outputText: string | null;
  startedAtMs: number;
  latencyMs: number;
  timeoutMs: number;
  maxRetries: number;
  attempt: number;
  requestIdHeader?: string;
  requestIdBody?: string;
  responseId?: string;
  usage?: LLMUsage;
  error?: LLMCallError;
  fallbackReason?: string;
}

export interface LLMChatResponseFormat {
  type: 'json_object';
}

export interface LLMChatRequest {
  endpoint: 'chat.completions';
  model: string;
  messages: Array<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: LLMChatResponseFormat;
}

export interface LLMResponsesRequest {
  endpoint: 'responses';
  model: string;
  instructions?: string;
  input: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
}

export interface LLMMessagesRequest {
  endpoint: 'messages';
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  top_p?: number;
  max_tokens: number;
}

export type LLMRequest = LLMChatRequest | LLMResponsesRequest | LLMMessagesRequest;

export interface LLMClientPort<TAgent extends LLMAgentId = LLMAgentId> {
  call(agent: TAgent, request: LLMRequest, nowMs?: number): Promise<LLMCallResult>;
}
