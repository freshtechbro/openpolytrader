import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import http from 'node:http';
import { once } from 'node:events';

import { MetricsStore } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import type { LLMConfig } from '../../src/config/llm.js';
import { selectProviders } from '../../src/services/llm/LLMRouter.js';
import { LLMClient } from '../../src/services/llm/LLMClient.js';
import { OpenAISdkClient, LLMTimeoutError } from '../../src/services/llm/OpenAISdkClient.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import type { LLMRequest, LLMProviderId } from '../../src/services/llm/types.js';

type OpenAIServerResponse = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  delayMs?: number;
};

type OpenAICompatHandler = (payload: unknown) => OpenAIServerResponse | Promise<OpenAIServerResponse>;

type OpenAICompatServer = {
  baseURL: string;
  calls: { chat: number; responses: number; messages: number };
  setChatHandler: (handler: OpenAICompatHandler) => void;
  setResponsesHandler: (handler: OpenAICompatHandler) => void;
  setMessagesHandler: (handler: OpenAICompatHandler) => void;
  close: () => Promise<void>;
};

async function startOpenAICompatServer(): Promise<OpenAICompatServer> {
  const calls = { chat: 0, responses: 0, messages: 0 };
  let chatHandler: OpenAICompatHandler = () => ({ status: 404, body: { error: { message: 'not_found' } } });
  let responsesHandler: OpenAICompatHandler = () => ({ status: 404, body: { error: { message: 'not_found' } } });
  let messagesHandler: OpenAICompatHandler = () => ({ status: 404, body: { error: { message: 'not_found' } } });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const payload = bodyText.trim().length > 0 ? safeParseJSON(bodyText) : null;

    let response: OpenAIServerResponse;
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      calls.chat += 1;
      response = await chatHandler(payload);
    } else if (req.method === 'POST' && url === '/v1/responses') {
      calls.responses += 1;
      response = await responsesHandler(payload);
    } else if (req.method === 'POST' && url === '/v1/messages') {
      calls.messages += 1;
      response = await messagesHandler(payload);
    } else {
      response = { status: 404, body: { error: { message: 'not_found' } } };
    }

    const writeResponse = () => {
      res.writeHead(response.status, {
        'content-type': 'application/json',
        ...response.headers
      });
      res.end(JSON.stringify(response.body));
    };

    if (typeof response.delayMs === 'number' && response.delayMs > 0) {
      setTimeout(writeResponse, response.delayMs);
      return;
    }
    writeResponse();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }

  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseURL,
    calls,
    setChatHandler: (handler) => {
      chatHandler = handler;
    },
    setResponsesHandler: (handler) => {
      responsesHandler = handler;
    },
    setMessagesHandler: (handler) => {
      messagesHandler = handler;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function safeParseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function makeConfig(args: {
  enabled: boolean;
  primary: { id: LLMProviderId; baseUrl: string; apiKey: string | null };
  fallback: { id: LLMProviderId; baseUrl: string; apiKey: string | null };
  timeoutMs?: number;
  circuitFailureThreshold?: number;
  fallbackEnabled?: boolean;
  primaryRetryCount?: number;
}): LLMConfig {
  const timeoutMs = args.timeoutMs ?? 50;
  const circuitFailureThreshold = args.circuitFailureThreshold ?? 2;
  const fallbackEnabled = args.fallbackEnabled ?? true;
  const primaryRetryCount = args.primaryRetryCount ?? 0;

  return {
    enabled: args.enabled,
    dataExportEnabled: false,
    fallbackEnabled,
    primaryRetryCount,
    primaryProvider: args.primary.id,
    fallbackProvider: args.fallback.id,
    providers: {
      'opencode-zen': {
        id: 'opencode-zen',
        baseUrl: args.primary.id === 'opencode-zen' ? args.primary.baseUrl : args.fallback.baseUrl,
        apiKey: args.primary.id === 'opencode-zen' ? args.primary.apiKey : args.fallback.apiKey,
        defaultHeaders: {}
      },
      openrouter: {
        id: 'openrouter',
        baseUrl: args.primary.id === 'openrouter' ? args.primary.baseUrl : args.fallback.baseUrl,
        apiKey: args.primary.id === 'openrouter' ? args.primary.apiKey : args.fallback.apiKey,
        defaultHeaders: {},
        openrouter: { sort: 'latency', allowFallbacks: true }
      }
    },
    retry: { timeoutMs: 100, maxRetries: 0 },
    circuitBreaker: { failureThreshold: circuitFailureThreshold, cooldownMs: 10, halfOpenSuccesses: 1 },
    agents: {
      ExecutionAgent: {
        provider: 'opencode-zen',
        model: 'm',
        backupModel: null,
        mode: 'disabled',
        timeoutMs
      },
      RiskAgent: { provider: 'opencode-zen', model: 'm', backupModel: null, mode: 'disabled', timeoutMs },
      ScannerAgent: {
        provider: 'opencode-zen',
        model: 'm',
        backupModel: null,
        mode: 'disabled',
        timeoutMs,
        scoreTopN: 20,
        scoreConcurrency: 3,
        shadowMinIntervalMs: 500
      },
      LearningAgent: { provider: 'opencode-zen', model: 'm', backupModel: null, mode: 'disabled', timeoutMs },
      PortfolioAgent: { provider: 'opencode-zen', model: 'm', backupModel: null, mode: 'disabled', timeoutMs },
      MarketDataAgent: { provider: 'opencode-zen', model: 'm', backupModel: null, mode: 'disabled', timeoutMs },
      OpsAgent: { provider: 'opencode-zen', model: 'm', backupModel: null, mode: 'disabled', timeoutMs }
    }
  };
}

const ACTIVE_REQUEST: LLMRequest = {
  endpoint: 'chat.completions',
  model: 'model-1',
  temperature: 0,
  messages: [
    { role: 'developer', content: 'Return JSON only.' },
    { role: 'user', content: '{"task":"ping"}' }
  ]
};

const RESPONSES_REQUEST: LLMRequest = {
  endpoint: 'responses',
  model: 'model-2',
  input: '{"task":"ping"}',
  instructions: 'Return JSON only.',
  temperature: 0,
  max_output_tokens: 200
};

describe('LLM services', () => {
  const servers: OpenAICompatServer[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Defensive: some tests stub/replace global fetch; ensure this suite always uses the native implementation.
    // This avoids flakiness when running under coverage/instrumentation.
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    for (const server of servers.splice(0, servers.length)) {
      await server.close();
    }
  });

  it('OpenAISdkClient: handles chat.completions and maps usage/request ids', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      headers: { 'x-request-id': 'hdr-1' },
      body: {
        id: 'chatcmpl-1',
        request_id: 'body-1',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const result = await client.request(ACTIVE_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 });

    expect(result.endpoint).toBe('chat.completions');
    expect(result.outputText).toBe('{"ok":true}');
    expect(result.requestIdHeader).toBe('hdr-1');
    expect(result.requestIdBody).toBe('body-1');
    expect(result.responseId).toBe('chatcmpl-1');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('LLMClient: maps Zen chat model ids when falling back to OpenRouter', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    let openrouterChatModel: string | null = null;

    primary.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    fallback.setChatHandler((payload) => {
      openrouterChatModel =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).model === 'string'
          ? String((payload as Record<string, unknown>).model)
          : null;
      return {
        status: 200,
        body: { id: 'chatcmpl-1', choices: [{ message: { content: '{"ok":true}' } }] }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('ExecutionAgent', { ...ACTIVE_REQUEST, model: 'glm-4.7' });

    expect(result.status).toBe('fallback');
    expect(openrouterChatModel).toBe('z-ai/glm-4.7');
  });

  it('LLMClient: preserves Zen claude ids when messages requests fall back to OpenRouter', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    let openrouterChatModel: string | null = null;

    primary.setMessagesHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    fallback.setChatHandler((payload) => {
      openrouterChatModel =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).model === 'string'
          ? String((payload as Record<string, unknown>).model)
          : null;
      return {
        status: 200,
        body: { id: 'chatcmpl-1', choices: [{ message: { content: '{"ok":true}' } }] }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', {
      endpoint: 'messages',
      model: 'claude-sonnet-4',
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 10
    });

    expect(result.status).toBe('fallback');
    expect(openrouterChatModel).toBe('claude-sonnet-4');
  });

  it('LLMClient: falls back when a messages response has empty output text', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setMessagesHandler(() => ({
      status: 200,
      body: { id: 'msg-empty', content: [{ type: 'text', text: '   ' }] }
    }));

    fallback.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000
    });
    config.agents.RiskAgent.mode = 'advisory';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', {
      endpoint: 'messages',
      model: 'claude-sonnet-4',
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 10
    });

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('openrouter');
    expect(result.outputText).toBe('{"ok":"fallback"}');
  });

  it('LLMClient: uses backup model before provider fallback (messages -> chat conversion)', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setMessagesHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    primary.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-backup', choices: [{ message: { content: '{"ok":"backup"}' } }] }
    }));

    fallback.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'should_not_be_called' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';
    config.agents.LearningAgent.backupModel = 'glm-4.7';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', {
      endpoint: 'messages',
      model: 'claude-sonnet-4',
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 10
    });

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('opencode-zen');
    expect(result.endpoint).toBe('chat.completions');
    expect(result.outputText).toBe('{"ok":"backup"}');
    expect(primary.calls.messages).toBe(1);
    expect(primary.calls.chat).toBe(1);
    expect(fallback.calls.chat).toBe(0);
  });

  it('LLMClient: converts responses request to messages for backup model', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setResponsesHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    primary.setMessagesHandler(() => ({
      status: 200,
      body: { id: 'msg-backup', content: [{ type: 'output_text', text: '{"ok":"backup"}' }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';
    config.agents.LearningAgent.backupModel = 'claude-sonnet-4';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', { ...RESPONSES_REQUEST, model: 'glm-4.7' });

    expect(result.status).toBe('fallback');
    expect(result.endpoint).toBe('messages');
    expect(primary.calls.responses).toBe(1);
    expect(primary.calls.messages).toBe(1);
  });

  it('LLMClient: converts messages request to responses for GPT-5 backup model', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setMessagesHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    primary.setResponsesHandler(() => ({
      status: 200,
      body: { id: 'resp-backup', output: [{ type: 'output_text', content: [{ type: 'text', text: '{"ok":"backup"}' }] }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';
    config.agents.LearningAgent.backupModel = 'gpt-5';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', {
      endpoint: 'messages',
      model: 'claude-sonnet-4',
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 10
    });

    expect(result.status).toBe('fallback');
    expect(result.endpoint).toBe('responses');
    expect(primary.calls.messages).toBe(1);
    expect(primary.calls.responses).toBe(1);
  });

  it('LLMClient: converts responses request to chat for explicit backup endpoint', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setResponsesHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    primary.setChatHandler(() => ({
      status: 200,
      body: { id: 'chat-backup', choices: [{ message: { content: '{"ok":"backup"}' } }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';
    config.agents.LearningAgent.backupModel = 'glm-4.7';
    config.agents.LearningAgent.backupEndpoint = 'chat.completions';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', { ...RESPONSES_REQUEST, model: 'glm-4.7' });

    expect(result.status).toBe('fallback');
    expect(result.endpoint).toBe('chat.completions');
    expect(primary.calls.responses).toBe(1);
    expect(primary.calls.chat).toBe(1);
  });

  it('LLMClient: falls back when backup model also fails', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    fallback.setChatHandler(() => ({
      status: 200,
      body: { id: 'chat-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';
    config.agents.ExecutionAgent.backupModel = 'glm-4.7';

    const client = new LLMClient(config);
    const result = await client.call('ExecutionAgent', { ...ACTIVE_REQUEST, model: 'glm-4.7' });

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('openrouter');
    expect(primary.calls.chat).toBe(2);
    expect(fallback.calls.chat).toBe(1);
  });

  it('LLMClient: leaves unknown endpoints unchanged during backup conversion', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    let responsesCalls = 0;
    primary.setResponsesHandler(() => {
      responsesCalls += 1;
      return { status: 500, body: { error: { message: 'boom' } } };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';
    config.agents.ExecutionAgent.backupModel = 'glm-4.7';
    config.agents.ExecutionAgent.backupEndpoint = 'chat.completions';

    const client = new LLMClient(config);
    const weirdRequest = {
      endpoint: 'weird',
      model: 'glm-4.7',
      input: '{"task":"ping"}',
      instructions: 'Return JSON only.',
      temperature: 0,
      max_output_tokens: 10
    } as unknown as LLMRequest;

    const result = await client.call('ExecutionAgent', weirdRequest);

    expect(result.status).toBe('error');
    expect(responsesCalls).toBe(2);
  });

  it('LLMClient: preserves unknown endpoints when converting to messages', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    let messagesCalls = 0;
    primary.setMessagesHandler(() => {
      messagesCalls += 1;
      if (messagesCalls === 1) {
        return { status: 500, body: { error: { message: 'boom' } } };
      }
      return {
        status: 200,
        body: {
          id: 'msg-backup',
          content: [{ type: 'text', text: '{"ok":"backup"}' }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: true
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';
    config.agents.ExecutionAgent.backupModel = 'claude-sonnet-4';
    config.agents.ExecutionAgent.backupEndpoint = 'messages';

    const client = new LLMClient(config);
    const weirdRequest = {
      endpoint: 'weird',
      model: 'claude-sonnet-4',
      messages: [
        { role: 'developer', content: 'Return JSON only.' },
        { role: 'user', content: '{"task":"ping"}' }
      ],
      temperature: 0,
      max_tokens: 10
    } as unknown as LLMRequest;

    const result = await client.call('ExecutionAgent', weirdRequest);

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('opencode-zen');
    expect(messagesCalls).toBe(2);
  });

  it('LLMClient: leaves unknown endpoints unchanged when converting to responses', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    let responsesCalls = 0;
    primary.setResponsesHandler(() => {
      responsesCalls += 1;
      if (responsesCalls === 1) {
        return { status: 500, body: { error: { message: 'boom' } } };
      }
      return {
        status: 200,
        body: { id: 'resp-backup', output_text: '{"ok":"backup"}' }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: false
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';
    config.agents.ExecutionAgent.backupModel = 'glm-4.7';
    config.agents.ExecutionAgent.backupEndpoint = 'responses';

    const client = new LLMClient(config);
    const weirdRequest = {
      endpoint: 'weird',
      model: 'glm-4.7',
      messages: [
        { role: 'developer', content: 'Return JSON only.' },
        { role: 'user', content: '{"task":"ping"}' }
      ],
      temperature: 0,
      max_tokens: 10
    } as unknown as LLMRequest;

    const result = await client.call('ExecutionAgent', weirdRequest);

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('opencode-zen');
    expect(responsesCalls).toBe(2);
  });

  it('LLMClient: skips provider fallback when disabled', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    primary.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    fallback.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000,
      fallbackEnabled: false
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('ExecutionAgent', { ...ACTIVE_REQUEST, model: 'glm-4.7' });

    expect(result.status).toBe('error');
    expect(result.providerId).toBe('opencode-zen');
    expect(fallback.calls.chat).toBe(0);
  });

  it('LLMClient: maps additional Zen model ids for OpenRouter fallback and preserves OpenRouter ids', async () => {
    const primary = await startOpenAICompatServer();
    const fallback = await startOpenAICompatServer();
    servers.push(primary, fallback);

    const seen: string[] = [];

    primary.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom' } }
    }));

    fallback.setChatHandler((payload) => {
      const model =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).model === 'string'
          ? String((payload as Record<string, unknown>).model)
          : 'missing';
      seen.push(model);
      return {
        status: 200,
        body: { id: 'chatcmpl-1', choices: [{ message: { content: '{"ok":true}' } }] }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primary.baseURL, apiKey: 'primary-key' },
      fallback: { id: 'openrouter', baseUrl: fallback.baseURL, apiKey: 'fallback-key' },
      timeoutMs: 1000
    });
    config.agents.ExecutionAgent.mode = 'advisory';
    config.agents.ExecutionAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);

    const modelsToTest = [
      ['glm-4.7', 'z-ai/glm-4.7'],
      ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
      ['minimax-m2.1', 'minimax/minimax-m2.1'],
      ['gpt-5-nano', 'openai/gpt-5-nano'],
      ['qwen3-coder', 'qwen/qwen3-coder'],
      ['openai/gpt-5-nano', 'openai/gpt-5-nano'],
      ['unknown-model', 'unknown-model']
    ] as const;

    for (const [inputModel] of modelsToTest) {
      const result = await client.call('ExecutionAgent', { ...ACTIVE_REQUEST, model: inputModel });
      expect(result.status).toBe('fallback');
    }

    expect(seen).toEqual(modelsToTest.map(([, expected]) => expected));
  });

  it('OpenAISdkClient: handles responses and maps output_text/usage', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setResponsesHandler(() => ({
      status: 200,
      headers: { 'x-request-id': 'hdr-2' },
      body: {
        id: 'resp-1',
        request_id: 'body-2',
        output_text: '{"outlier":false}',
        usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 }
      }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const result = await client.request(RESPONSES_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 });

    expect(result.endpoint).toBe('responses');
    expect(result.outputText).toBe('{"outlier":false}');
    expect(result.requestIdHeader).toBe('hdr-2');
    expect(result.requestIdBody).toBe('body-2');
    expect(result.responseId).toBe('resp-1');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  });

  it('OpenAISdkClient: maps APIError to Error with status', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 429,
      headers: { 'x-request-id': 'hdr-rate' },
      body: { error: { message: 'rate_limited', type: 'rate_limit' } }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    await expect(client.request(ACTIVE_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 })).rejects.toMatchObject({
      message: expect.stringContaining('rate_limited'),
      status: 429,
      requestIdHeader: 'hdr-rate'
    });
  });

  it('LLMClient: maps non-string error.message and preserves numeric status', async () => {
    const cfg = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://primary.invalid', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://fallback.invalid', apiKey: 'k' }
    });
    cfg.agents.ScannerAgent.mode = 'advisory';

    const client = new LLMClient(cfg);
    const privateClient = client as unknown as {
      clients: Map<LLMProviderId, { request: (req: LLMRequest, opts: { timeoutMs: number; maxRetries: number; attempt: number }) => Promise<unknown> }>;
    };

    privateClient.clients.set('opencode-zen', {
      request: async () => {
        throw new Error('primary_down');
      }
    });
    privateClient.clients.set('openrouter', {
      request: async () => {
        throw { message: 123, status: 500 };
      }
    });

    const result = await client.call('ScannerAgent', ACTIVE_REQUEST, 0);

    expect(result.status).toBe('error');
    expect(result.error).toEqual({ type: 'error', status: 500, message: 'unknown_error' });
  });

  it('OpenAISdkClient: maps connection timeouts to LLMTimeoutError', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setResponsesHandler(() => ({
      status: 200,
      delayMs: 200,
      body: { id: 'resp-delayed', output_text: '{"ok":true}' }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 10,
      maxRetries: 0
    });

    await expect(client.request(RESPONSES_REQUEST, { timeoutMs: 10, maxRetries: 0, attempt: 1 })).rejects.toBeInstanceOf(
      LLMTimeoutError
    );
  });

  it('OpenAISdkClient: maps missing usage + requestId fallback safely', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: {
        id: 'chatcmpl-no-usage',
        requestId: 'body-alt',
        choices: [{ message: { content: 123 } }]
      }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const result = await client.request(ACTIVE_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 });

    expect(result.outputText).toBeNull();
    expect(result.usage).toBeUndefined();
    expect(result.requestIdBody).toBe('body-alt');
  });

  it('OpenAISdkClient: maps non-numeric usage tokens to undefined (chat)', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: {
        id: 'chatcmpl-usage-invalid',
        request_id: 'rid',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 'x', completion_tokens: null, total_tokens: false }
      }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const result = await client.request(ACTIVE_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 });
    expect(result.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  });

  it('OpenAISdkClient: maps non-numeric usage tokens to undefined (responses)', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setResponsesHandler(() => ({
      status: 200,
      body: {
        id: 'resp-usage-invalid',
        requestId: 'rid2',
        output_text: 123,
        usage: { input_tokens: 'x', output_tokens: null, total_tokens: {} }
      }
    }));

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL: server.baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const result = await client.request(RESPONSES_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 });
    expect(result.outputText).toBeNull();
    expect(result.requestIdBody).toBe('rid2');
    expect(result.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  });

  it('OpenAISdkClient: rethrows unexpected response parse errors', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    const client = new OpenAISdkClient({
      apiKey: 'key',
      baseURL,
      timeoutMs: 1000,
      maxRetries: 0
    });

    await expect(client.request(ACTIVE_REQUEST, { timeoutMs: 250, maxRetries: 0, attempt: 1 })).rejects.toBeInstanceOf(
      Error
    );

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('selectProviders chooses the opposite provider as fallback', () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });
    config.agents.RiskAgent.provider = 'opencode-zen';

    expect(selectProviders(config, 'RiskAgent')).toMatchObject({
      primaryId: 'opencode-zen',
      fallbackId: 'openrouter'
    });

    config.agents.RiskAgent.provider = 'openrouter';
    expect(selectProviders(config, 'RiskAgent')).toMatchObject({
      primaryId: 'openrouter',
      fallbackId: 'opencode-zen'
    });
  });

  it('selectProviders throws when primary and fallback providers match', () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });
    config.primaryProvider = 'opencode-zen';
    config.fallbackProvider = 'opencode-zen';
    config.agents.RiskAgent.provider = 'opencode-zen';

    expect(() => selectProviders(config, 'RiskAgent')).toThrow(/fallback provider equals primary/i);
  });

  it('LLMClient: returns disabled when globally disabled', async () => {
    const config = makeConfig({
      enabled: false,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: null },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: null }
    });
    config.agents.RiskAgent.mode = 'shadow';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', ACTIVE_REQUEST, 123);

    expect(result).toMatchObject({ status: 'disabled', startedAtMs: 123, outputText: null });
  });

  it('LLMClient: success path records llm_latency', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      headers: { 'x-request-id': 'hdr-llm' },
      body: { id: 'chatcmpl-llm', choices: [{ message: { content: '{"ok":true}' } }] }
    }));

    const env = loadEnv({});
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config, { metrics });
    const result = await client.call('RiskAgent', ACTIVE_REQUEST);

    expect(result.status).toBe('success');
    expect(result.providerId).toBe('opencode-zen');
    expect(result.outputText).toBe('{"ok":true}');
    expect(metrics.snapshot().counts.llm_latency).toBeGreaterThan(0);
  });

  it('LLMClient: downgrades responses requests to chat.completions for openrouter', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-resp-downgrade', choices: [{ message: { content: '{"ok":true}' } }] }
    }));
    server.setResponsesHandler(() => ({
      status: 500,
      body: { error: { message: 'responses_should_not_be_called', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'openrouter';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', RESPONSES_REQUEST);

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('chat.completions');
    expect(server.calls.chat).toBe(1);
    expect(server.calls.responses).toBe(0);
  });

  it('LLMClient: routes gpt-5 chat requests to responses for opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenModel: string | null = null;

    server.setResponsesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenModel = (payload as { model?: string }).model ?? null;
      }
      return {
        status: 200,
        body: { id: 'resp-gpt5', output_text: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 2 } }
      };
    });
    server.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'chat_should_not_be_called', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', { ...ACTIVE_REQUEST, model: 'openai/gpt-5-nano' });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('responses');
    expect(result.outputText).toBe('{"ok":true}');
    expect(server.calls.responses).toBe(1);
    expect(server.calls.chat).toBe(0);
    expect(seenModel).toBe('gpt-5-nano');
  });

  it('LLMClient: omits instructions when chat system is whitespace', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenInstructions: string | undefined = 'unset';

    server.setResponsesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenInstructions = (payload as { instructions?: string }).instructions;
      }
      return {
        status: 200,
        body: { id: 'resp-no-instructions', output_text: '{"ok":true}' }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', {
      endpoint: 'chat.completions',
      model: 'gpt-5-nano',
      temperature: 0,
      messages: [
        { role: 'developer', content: '   ' },
        { role: 'user', content: '{"task":"ping"}' }
      ]
    });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('responses');
    expect(seenInstructions).toBeUndefined();
  });

  it('LLMClient: keeps responses requests for gpt-5 on opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setResponsesHandler(() => ({
      status: 200,
      body: { id: 'resp-gpt5-direct', output_text: '{"ok":true}' }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', {
      ...RESPONSES_REQUEST,
      model: 'gpt-5-nano'
    });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('responses');
    expect(server.calls.responses).toBe(1);
  });

  it('LLMClient: routes Claude chat requests to messages for opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenModel: string | null = null;
    let seenSystem: string | null = null;

    server.setMessagesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenModel = (payload as { model?: string }).model ?? null;
        seenSystem = (payload as { system?: string }).system ?? null;
      }
      return {
        status: 200,
        body: {
          id: 'msg-claude',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1, output_tokens: 2 }
        }
      };
    });
    server.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'chat_should_not_be_called', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', { ...ACTIVE_REQUEST, model: 'anthropic/claude-3.5-sonnet' });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('messages');
    expect(result.outputText).toBe('{"ok":true}');
    expect(server.calls.messages).toBe(1);
    expect(server.calls.chat).toBe(0);
    expect(seenModel).toBe('claude-3.5-sonnet');
    expect(seenSystem).toContain('Return JSON only.');
  });

  it('LLMClient: uses explicit max_tokens when converting chat to messages for opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenMaxTokens: number | null = null;

    server.setMessagesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenMaxTokens = (payload as { max_tokens?: number }).max_tokens ?? null;
      }
      return {
        status: 200,
        body: {
          id: 'msg-max-tokens',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    await client.call('LearningAgent', {
      ...ACTIVE_REQUEST,
      model: 'anthropic/claude-3.5-sonnet',
      max_tokens: 123
    });

    expect(seenMaxTokens).toBe(123);
  });

  it('LLMClient: routes responses requests to messages for Claude on opencode-zen', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/v1/messages');
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      expect((payload as { system?: string }).system).toBe('Return JSON only.');

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'msg-resp-claude',
            content: [{ type: 'text', text: '{"ok":true}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          })
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://example.test/v1', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://example.test/v1', apiKey: 'k' }
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    try {
      const client = new LLMClient(config);
      const result = await client.call('LearningAgent', {
        ...RESPONSES_REQUEST,
        model: 'anthropic/claude-3.5-sonnet'
      });

      expect(result.status).toBe('success');
      expect(result.endpoint).toBe('messages');
      expect(result.outputText).toBe('{"ok":true}');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('LLMClient: defaults max_tokens and omits system when responses lack instructions', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenSystem: string | null = 'unset';
    let seenMaxTokens: number | null = null;

    server.setMessagesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenSystem = (payload as { system?: string }).system ?? null;
        seenMaxTokens = (payload as { max_tokens?: number }).max_tokens ?? null;
      }
      return {
        status: 200,
        body: {
          id: 'msg-defaults',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    await client.call('LearningAgent', {
      endpoint: 'responses',
      model: 'anthropic/claude-3.5-sonnet',
      input: '{"task":"ping"}',
      temperature: 0
    });

    expect(seenSystem).toBeNull();
    expect(seenMaxTokens).toBe(200);
  });

  it('LLMClient: routes messages requests to responses for gpt-5 on opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenInput: string | null = null;

    server.setResponsesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenInput = (payload as { input?: string }).input ?? null;
      }
      return {
        status: 200,
        body: { id: 'resp-from-msg', output_text: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 1 } }
      };
    });
    server.setMessagesHandler(() => ({
      status: 500,
      body: { error: { message: 'messages_should_not_be_called', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', {
      endpoint: 'messages',
      model: 'gpt-5-nano',
      system: 'Return JSON only.',
      messages: [{ role: 'assistant', content: 'previous' }],
      temperature: 0,
      max_tokens: 200
    });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('responses');
    expect(result.outputText).toBe('{"ok":true}');
    expect(server.calls.responses).toBe(1);
    expect(server.calls.messages).toBe(0);
    expect(seenInput).toBe('');
  });

  it('LLMClient: omits instructions when messages request has no system', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenInstructions: string | undefined = 'unset';

    server.setResponsesHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenInstructions = (payload as { instructions?: string }).instructions;
      }
      return {
        status: 200,
        body: { id: 'resp-no-system', output_text: '{"ok":true}' }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.MarketDataAgent.mode = 'advisory';
    config.agents.MarketDataAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('MarketDataAgent', {
      endpoint: 'messages',
      model: 'gpt-5-nano',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 200
    });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('responses');
    expect(seenInstructions).toBeUndefined();
  });

  it('LLMClient: keeps unmapped namespaced model ids for opencode-zen', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    let seenModel: string | null = null;

    server.setChatHandler((payload) => {
      if (payload && typeof payload === 'object') {
        seenModel = (payload as { model?: string }).model ?? null;
      }
      return {
        status: 200,
        body: { id: 'chat-unmapped', choices: [{ message: { content: '{"ok":true}' } }] }
      };
    });

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', { ...ACTIVE_REQUEST, model: 'vendor/' });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('chat.completions');
    expect(seenModel).toBe('vendor/');
  });

  it('LLMClient: supports Zen messages endpoint with x-api-key and extracts text', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/v1/messages');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'x-api-key': 'k' });

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'msg-1',
            type: 'message',
            role: 'assistant',
            model: 'MiniMax-M2.1',
            content: [{ type: 'text', text: '{"ok":true}' }],
            usage: { input_tokens: 12, output_tokens: 34 }
          })
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig({
        enabled: true,
        primary: { id: 'opencode-zen', baseUrl: 'http://example.test/v1', apiKey: 'k' },
        fallback: { id: 'openrouter', baseUrl: 'http://example.test/v1', apiKey: 'k' }
      },
      { timeoutMs: 5000 }
    );
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    try {
      const client = new LLMClient(config);
      const result = await client.call('LearningAgent', {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 'Return JSON only.',
        messages: [{ role: 'user', content: '{"task":"ping"}' }],
        temperature: 0,
        max_tokens: 200
      });

      expect(result.status).toBe('success');
      expect(result.endpoint).toBe('messages');
      expect(result.outputText).toBe('{"ok":true}');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('LLMClient: normalizes messages -> chat.completions for openrouter', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-messages-normalized', choices: [{ message: { content: '{"ok":true}' } }] }
    }));
    server.setMessagesHandler(() => ({
      status: 500,
      body: { error: { message: 'messages_should_not_be_called', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' },
      fallback: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' }
    });
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'openrouter';

    const client = new LLMClient(config);
    const result = await client.call('LearningAgent', {
      endpoint: 'messages',
      model: 'claude-sonnet-4',
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"task":"ping"}' }],
      temperature: 0,
      max_tokens: 200
    });

    expect(result.status).toBe('success');
    expect(result.endpoint).toBe('chat.completions');
    expect(result.outputText).toBe('{"ok":true}');
    expect(server.calls.chat).toBe(1);
    expect(server.calls.messages).toBe(0);
  });

  it('LLMClient: treats AbortError as timeout and can fall back for messages', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-timeout-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const config = makeConfig(
      {
        enabled: true,
        primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
        fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
      },
      { timeoutMs: 250 }
    );
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('aborted');
      (err as { name: string }).name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    try {
      const client = new LLMClient(config);
      const result = await client.call('LearningAgent', {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 'Return JSON only.',
        messages: [{ role: 'user', content: '{"task":"ping"}' }],
        temperature: 0,
        max_tokens: 200
      });

      expect(result.status).toBe('fallback');
      expect(result.providerId).toBe('openrouter');
      expect(result.endpoint).toBe('chat.completions');
      expect(result.outputText).toBe('{"ok":"fallback"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLMClient: treats AbortError without message as timeout', async () => {
    const server = await startOpenAICompatServer();
    servers.push(server);

    server.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-timeout-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const config = makeConfig(
      {
        enabled: true,
        primary: { id: 'opencode-zen', baseUrl: server.baseURL, apiKey: 'k' },
        fallback: { id: 'openrouter', baseUrl: server.baseURL, apiKey: 'k' }
      },
      { timeoutMs: 250 }
    );
    config.agents.LearningAgent.mode = 'active';
    config.agents.LearningAgent.provider = 'opencode-zen';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw { name: 'AbortError' };
    }) as unknown as typeof fetch;

    try {
      const client = new LLMClient(config);
      const result = await client.call('LearningAgent', {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 'Return JSON only.',
        messages: [{ role: 'user', content: '{"task":"ping"}' }],
        temperature: 0,
        max_tokens: 200
      });

      expect(result.status).toBe('fallback');
      expect(result.providerId).toBe('openrouter');
      expect(result.outputText).toBe('{"ok":"fallback"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLMClient: falls back when primary returns API error', async () => {
    const primaryServer = await startOpenAICompatServer();
    const fallbackServer = await startOpenAICompatServer();
    servers.push(primaryServer, fallbackServer);

    primaryServer.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom', type: 'server_error' } }
    }));
    fallbackServer.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-fallback', choices: [{ message: { content: '{"ok":"fallback"}' } }] }
    }));

    const env = loadEnv({});
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primaryServer.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: fallbackServer.baseURL, apiKey: 'k' },
      timeoutMs: 1000
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config, { metrics });
    const result = await client.call('RiskAgent', ACTIVE_REQUEST);

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('openrouter');
    expect(result.fallbackReason).toBe('primary_error');
    expect(metrics.snapshot().counts.llm_error).toBeGreaterThan(0);
  });

  it('LLMClient: falls back when primary times out and avoids re-calling open circuit', async () => {
    const primaryServer = await startOpenAICompatServer();
    const fallbackServer = await startOpenAICompatServer();
    servers.push(primaryServer, fallbackServer);

    primaryServer.setChatHandler(() => ({
      status: 200,
      delayMs: 200,
      body: { id: 'chatcmpl-delayed', choices: [{ message: { content: '{"ok":true}' } }] }
    }));
    fallbackServer.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-fast', choices: [{ message: { content: '{"ok":"fast"}' } }] }
    }));

    const env = loadEnv({});
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primaryServer.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: fallbackServer.baseURL, apiKey: 'k' },
      timeoutMs: 100,
      circuitFailureThreshold: 1
    });
    config.circuitBreaker.cooldownMs = 10_000;
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';
    config.agents.RiskAgent.timeoutMs = 100;

    const client = new LLMClient(config, { metrics });

    const first = await client.call('RiskAgent', ACTIVE_REQUEST);
    expect(first.status).toBe('fallback');
    expect(metrics.snapshot().counts.llm_timeout).toBeGreaterThan(0);

    const second = await client.call('RiskAgent', ACTIVE_REQUEST);
    expect(second.status).toBe('fallback');

    expect(primaryServer.calls.chat).toBe(1);
    expect(fallbackServer.calls.chat).toBe(2);
  });

  it('LLMClient: returns missing_api_key error from primary without network call', async () => {
    const fallbackServer = await startOpenAICompatServer();
    servers.push(fallbackServer);

    fallbackServer.setChatHandler(() => ({
      status: 200,
      body: { id: 'chatcmpl-ok', choices: [{ message: { content: '{"ok":true}' } }] }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://127.0.0.1:1/v1', apiKey: null },
      fallback: { id: 'openrouter', baseUrl: fallbackServer.baseURL, apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', ACTIVE_REQUEST);

    expect(result.status).toBe('fallback');
    expect(result.providerId).toBe('openrouter');
  });

  it('LLMClient: returns fallback failure when both providers fail', async () => {
    const primaryServer = await startOpenAICompatServer();
    const fallbackServer = await startOpenAICompatServer();
    servers.push(primaryServer, fallbackServer);

    primaryServer.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom-primary', type: 'server_error' } }
    }));
    fallbackServer.setChatHandler(() => ({
      status: 500,
      body: { error: { message: 'boom-fallback', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primaryServer.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: fallbackServer.baseURL, apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', ACTIVE_REQUEST);

    expect(result.status).toBe('error');
    expect(result.providerId).toBe('openrouter');
  });

  it('LLMClient: preserves request id header on API errors', async () => {
    const primaryServer = await startOpenAICompatServer();
    const fallbackServer = await startOpenAICompatServer();
    servers.push(primaryServer, fallbackServer);

    primaryServer.setChatHandler(() => ({
      status: 500,
      headers: { 'x-request-id': 'hdr-primary' },
      body: { error: { message: 'boom-primary', type: 'server_error' } }
    }));
    fallbackServer.setChatHandler(() => ({
      status: 500,
      headers: { 'x-request-id': 'hdr-fallback' },
      body: { error: { message: 'boom-fallback', type: 'server_error' } }
    }));

    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: primaryServer.baseURL, apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: fallbackServer.baseURL, apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const result = await client.call('RiskAgent', ACTIVE_REQUEST);

    expect(result.status).toBe('error');
    expect(result.providerId).toBe('openrouter');
    expect(result.requestIdHeader).toBe('hdr-fallback');
  });

  it('LLMClient: getClient throws when provider API key missing', () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: null },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });

    const client = new LLMClient(config);
    expect(() =>
      (client as unknown as { getClient: (providerId: LLMProviderId) => unknown }).getClient('opencode-zen')
    ).toThrow(/missing API key/i);
  });

  it('LLMClient: getZenMessagesClient throws when provider is not opencode-zen', () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });

    const client = new LLMClient(config);
    expect(() =>
      (client as unknown as { getZenMessagesClient: (providerId: LLMProviderId) => unknown }).getZenMessagesClient('openrouter')
    ).toThrow(/messages endpoint not supported/i);
  });

  it('LLMClient: getZenMessagesClient throws when API key missing', () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: null },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });

    const client = new LLMClient(config);
    expect(() =>
      (client as unknown as { getZenMessagesClient: (providerId: LLMProviderId) => unknown }).getZenMessagesClient('opencode-zen')
    ).toThrow(/missing API key/i);
  });

  it('LLMClient: maps non-object thrown errors via String(error)', async () => {
    const config = makeConfig({
      enabled: true,
      primary: { id: 'opencode-zen', baseUrl: 'http://localhost/v1', apiKey: 'k' },
      fallback: { id: 'openrouter', baseUrl: 'http://localhost/v1', apiKey: 'k' }
    });
    config.agents.RiskAgent.mode = 'shadow';
    config.agents.RiskAgent.provider = 'opencode-zen';

    const client = new LLMClient(config);
    const internals = client as unknown as {
      clients: Map<LLMProviderId, { request: (req: LLMRequest, opts: { timeoutMs: number; maxRetries: number; attempt: number }) => Promise<unknown> }>;
      tryProvider: (args: {
        providerId: LLMProviderId;
        agent: 'RiskAgent';
        request: LLMRequest;
        timeoutMs: number;
        maxRetries: number;
        attempt: number;
        startedAtMs: number;
      }) => Promise<{ status: string; error?: { message: string } }>;
    };

    internals.clients.set('opencode-zen', {
      request: async () => {
        throw 'boom';
      }
    });

    const result = await internals.tryProvider({
      providerId: 'opencode-zen',
      agent: 'RiskAgent',
      request: ACTIVE_REQUEST,
      timeoutMs: 50,
      maxRetries: 0,
      attempt: 1,
      startedAtMs: Date.now()
    });

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('boom');
  });

  it('MockLLMClient requires a base URL and supports defaults + clear', async () => {
    expect(() => new MockLLMClient()).toThrow(/requires defaultBaseUrl/i);

    const llm = new MockLLMClient({ defaultBaseUrl: 'http://localhost/v1' });
    llm.setDefault('RiskAgent', { status: 'success', outputText: '{"ok":true}' });

    const first = await llm.call('RiskAgent', ACTIVE_REQUEST);
    expect(first.status).toBe('success');

    llm.enqueue('RiskAgent', { status: 'success', outputText: '{"ok":"queued"}', latencyMs: 1 });
    const secondQueued = await llm.call('RiskAgent', ACTIVE_REQUEST);
    expect(secondQueued.outputText).toBe('{"ok":"queued"}');

    llm.clear('RiskAgent');
    const second = await llm.call('RiskAgent', ACTIVE_REQUEST);
    expect(second.status).toBe('error');

    llm.setDefault('RiskAgent', { status: 'success', outputText: '{"ok":true}' });
    llm.clear();
    const afterClearAll = await llm.call('RiskAgent', ACTIVE_REQUEST);
    expect(afterClearAll.status).toBe('error');
  });
});
