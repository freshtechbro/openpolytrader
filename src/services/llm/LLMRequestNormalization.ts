import type {
  LLMChatRequest,
  LLMEndpoint,
  LLMMessagesRequest,
  LLMProviderId,
  LLMRequest,
  LLMResponsesRequest
} from './types.js';

const OPENROUTER_TO_ZEN_MODEL_ID: Record<string, string> = {
  'x-ai/grok-code-fast-1': 'glm-4.7',
  'moonshotai/kimi-k2.5': 'kimi-k2.5',
  'z-ai/glm-4.7': 'glm-4.7',
  'openai/gpt-5-nano': 'gpt-5-nano',
  'minimax/minimax-m2.1': 'minimax-m2.1',
  'qwen/qwen3-coder': 'qwen3-coder',
  'qwen/qwen3-coder-next': 'qwen3-coder'
};

export function normalizeOptionalModelId(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeRequestForProvider(providerId: LLMProviderId, request: LLMRequest): LLMRequest {
  if (providerId === 'opencode-zen') {
    return normalizeZenProviderRequest(request);
  }

  if (providerId !== 'openrouter') {
    return request;
  }

  return normalizeOpenRouterRequest(request);
}

export function buildBackupRequest(
  request: LLMRequest,
  backupModel: string,
  backupEndpoint?: LLMEndpoint
): LLMRequest {
  const model = backupModel.trim();
  const requestWithModel = request.model === model ? request : { ...request, model };
  const targetEndpoint = backupEndpoint ?? inferEndpointForModel(model);
  return convertRequestEndpoint(requestWithModel, targetEndpoint);
}

function normalizeZenProviderRequest(request: LLMRequest): LLMRequest {
  const mappedModel = mapOpenRouterModelIdToZen(request.model);

  if (isGPT5FamilyModel(mappedModel)) {
    if (request.endpoint === 'responses') {
      return request.model === mappedModel ? request : { ...request, model: mappedModel };
    }
    if (request.endpoint === 'messages') {
      return messagesToResponsesRequest(request, mappedModel);
    }
    return chatToResponsesRequest(request, mappedModel);
  }

  if (wantsZenMessagesEndpoint(mappedModel)) {
    if (request.endpoint === 'messages') {
      return request.model === mappedModel ? request : { ...request, model: mappedModel };
    }
    if (request.endpoint === 'responses') {
      return responsesToZenMessagesRequest(request, mappedModel);
    }
    return chatToZenMessagesRequest(request, mappedModel);
  }

  if (request.endpoint === 'messages') {
    return messagesToChatRequest({ ...request, model: mappedModel }, mappedModel);
  }

  return request.model === mappedModel ? request : { ...request, model: mappedModel };
}

function normalizeOpenRouterRequest(request: LLMRequest): LLMRequest {
  const mappedModel = mapZenModelIdToOpenRouter(request.model);

  if (request.endpoint === 'messages') {
    return messagesToChatRequest({ ...request, model: mappedModel }, mappedModel);
  }

  if (request.endpoint !== 'responses') {
    if (request.endpoint !== 'chat.completions') return request;
    return request.model === mappedModel ? request : { ...request, model: mappedModel };
  }

  return responsesToChatRequest({ ...request, model: mappedModel }, mappedModel);
}

function inferEndpointForModel(model: string): LLMEndpoint {
  if (isGPT5FamilyModel(model)) return 'responses';
  if (wantsZenMessagesEndpoint(model)) return 'messages';
  return 'chat.completions';
}

function convertRequestEndpoint(request: LLMRequest, endpoint: LLMEndpoint): LLMRequest {
  if (request.endpoint === endpoint) return request;

  if (endpoint === 'chat.completions') {
    if (request.endpoint === 'messages') return messagesToChatRequest(request, request.model);
    if (request.endpoint === 'responses') return responsesToChatRequest(request, request.model);
    return request;
  }

  if (endpoint === 'messages') {
    if (request.endpoint === 'chat.completions') return chatToZenMessagesRequest(request, request.model);
    if (request.endpoint === 'responses') return responsesToZenMessagesRequest(request, request.model);
    return request;
  }

  if (request.endpoint === 'chat.completions') return chatToResponsesRequest(request, request.model);
  if (request.endpoint === 'messages') return messagesToResponsesRequest(request, request.model);
  return request;
}

function normalizeZenModelId(model: string): string {
  return model;
}

function mapOpenRouterModelIdToZen(model: string): string {
  if (!model.includes('/')) return normalizeZenModelId(model);

  const mapped = OPENROUTER_TO_ZEN_MODEL_ID[model];
  if (mapped) return normalizeZenModelId(mapped);

  const lastSlash = model.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < model.length - 1) {
    return normalizeZenModelId(model.slice(lastSlash + 1));
  }

  return normalizeZenModelId(model);
}

function isGPT5FamilyModel(model: string): boolean {
  return model === 'gpt-5' || model.startsWith('gpt-5-');
}

function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-');
}

function wantsZenMessagesEndpoint(model: string): boolean {
  return isClaudeModel(model);
}

function extractChatSystem(messages: LLMChatRequest['messages']): string | undefined {
  const fragments: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'developer' || msg.role === 'system') {
      const content = msg.content.trim();
      if (content.length > 0) fragments.push(content);
    }
  }

  if (fragments.length === 0) return undefined;
  return fragments.join('\n\n');
}

function isUserOrAssistantMessage(
  message: LLMChatRequest['messages'][number]
): message is { role: 'user' | 'assistant'; content: string } {
  return message.role === 'user' || message.role === 'assistant';
}

function extractChatUserAssistantMessages(
  messages: LLMChatRequest['messages']
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.filter(isUserOrAssistantMessage).map((msg) => ({ role: msg.role, content: msg.content }));
}

function lastUserContent(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function messagesToChatRequest(req: LLMMessagesRequest, model: string): LLMChatRequest {
  const system = typeof req.system === 'string' ? req.system.trim() : '';
  const messages: Array<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }> = [];
  if (system.length > 0) messages.push({ role: 'developer', content: system });
  for (const msg of req.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return {
    endpoint: 'chat.completions',
    model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens
  };
}

function responsesToChatRequest(req: LLMResponsesRequest, model: string): LLMChatRequest {
  const instructions = typeof req.instructions === 'string' ? req.instructions.trim() : '';
  const messages: Array<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }> = [];
  if (instructions.length > 0) {
    messages.push({ role: 'developer', content: instructions });
  }
  messages.push({ role: 'user', content: req.input });

  return {
    endpoint: 'chat.completions',
    model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_output_tokens
  };
}

function chatToZenMessagesRequest(req: LLMChatRequest, model: string): LLMMessagesRequest {
  const system = extractChatSystem(req.messages);
  const messages = extractChatUserAssistantMessages(req.messages);
  const maxTokens = typeof req.max_tokens === 'number' ? req.max_tokens : 200;

  return {
    endpoint: 'messages',
    model,
    system,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: maxTokens
  };
}

function chatToResponsesRequest(req: LLMChatRequest, model: string): LLMResponsesRequest {
  const instructions = extractChatSystem(req.messages);
  const input = lastUserContent(req.messages);

  return {
    endpoint: 'responses',
    model,
    instructions,
    input,
    temperature: req.temperature,
    top_p: req.top_p,
    max_output_tokens: req.max_tokens
  };
}

function responsesToZenMessagesRequest(req: LLMResponsesRequest, model: string): LLMMessagesRequest {
  const system = typeof req.instructions === 'string' ? req.instructions.trim() : '';
  const maxTokens = typeof req.max_output_tokens === 'number' ? req.max_output_tokens : 200;

  return {
    endpoint: 'messages',
    model,
    system: system.length > 0 ? system : undefined,
    messages: [{ role: 'user', content: req.input }],
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: maxTokens
  };
}

function messagesToResponsesRequest(req: LLMMessagesRequest, model: string): LLMResponsesRequest {
  const instructions = typeof req.system === 'string' ? req.system.trim() : '';
  const input = lastUserContent(req.messages);

  return {
    endpoint: 'responses',
    model,
    instructions: instructions.length > 0 ? instructions : undefined,
    input,
    temperature: req.temperature,
    top_p: req.top_p,
    max_output_tokens: req.max_tokens
  };
}

function mapZenModelIdToOpenRouter(model: string): string {
  if (model.includes('/')) return model;

  const normalized = normalizeZenModelId(model);

  switch (normalized) {
    case 'glm-4.7':
      return 'z-ai/glm-4.7';
    case 'kimi-k2.5':
      return 'moonshotai/kimi-k2.5';
    case 'gpt-5-nano':
      return 'openai/gpt-5-nano';
    case 'minimax-m2.1':
      return 'minimax/minimax-m2.1';
    case 'qwen3-coder':
      return 'qwen/qwen3-coder-next';
    default:
      return normalized;
  }
}
