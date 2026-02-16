import { afterEach, describe, expect, it } from 'vitest';

import http from 'node:http';
import { once } from 'node:events';

import { ZenMessagesClient, ZenMessagesError } from '../../src/services/llm/ZenMessagesClient.js';

type ServerResponse = {
  status: number;
  headers?: Record<string, string>;
  body: string;
};

async function startServer(handler: () => ServerResponse | Promise<ServerResponse>) {
  const server = http.createServer(async (_req, res) => {
    const response = await handler();
    res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
    res.end(response.body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind server');

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe('ZenMessagesClient', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0, servers.length)) {
      await server.close();
    }
  });

  it('parses message text blocks + usage', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-1',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' }
        ],
        usage: { input_tokens: 1, output_tokens: 2 }
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 'Return JSON only.',
        messages: [{ role: 'user', content: '{"task":"ping"}' }],
        temperature: 0,
        max_tokens: 200
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.endpoint).toBe('messages');
    expect(result.responseId).toBe('msg-1');
    expect(result.outputText).toBe('hello\nworld');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('accepts string content when content is not an array', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ id: 'msg-2', content: 'oops' })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: null,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBe('oops');
    expect(result.usage).toBeUndefined();
  });

  it('accepts output_text when present on a messages response', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ id: 'msg-output-text', output_text: 'pong' })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBe('pong');
  });

  it('returns null output when content blocks have no usable text', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-empty',
        content: [
          null,
          { type: 'text', text: '   ' },
          { type: 'tool', name: 'noop' },
          {}
        ],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBeNull();
  });

  it('ignores blank and non-object nested message content values', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-blank-fields',
        output_text: '   ',
        text: '   ',
        content: [
          '   ',
          123,
          { content: '   ', value: '   ', output_text: '   ', text: { text: '   ' } }
        ]
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBeNull();
  });

  it('extracts text from nested message and choices fields', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-nested',
        message: { text: 'hello' },
        choices: [{ content: 'world' }]
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBe('hello\nworld');
  });

  it('extracts text from output arrays and nested content', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-output',
        output: [{ text: 'alpha' }, { content: { text: 'beta' } }]
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBe('alpha\nbeta');
  });

  it('throws ZenMessagesError with parsed error.message', async () => {
    const server = await startServer(() => ({
      status: 400,
      body: JSON.stringify({ error: { message: 'bad_request' } })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });

    await expect(
      client.request(
        {
          endpoint: 'messages',
          model: 'claude-sonnet-4',
          system: 's',
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          max_tokens: 1
        },
        { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
      )
    ).rejects.toMatchObject<Partial<ZenMessagesError>>({ name: 'ZenMessagesError', message: 'bad_request', status: 400 });
  });

  it('falls back to http_<status> for non-JSON error bodies', async () => {
    const server = await startServer(() => ({
      status: 500,
      body: 'not-json'
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });

    await expect(
      client.request(
        {
          endpoint: 'messages',
          model: 'claude-sonnet-4',
          system: 's',
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          max_tokens: 1
        },
        { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
      )
    ).rejects.toMatchObject<Partial<ZenMessagesError>>({ name: 'ZenMessagesError', message: 'http_500', status: 500 });
  });

  it('falls back to http_<status> when error message is not a string', async () => {
    const server = await startServer(() => ({
      status: 418,
      body: JSON.stringify({ error: { message: 123 } })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });

    await expect(
      client.request(
        {
          endpoint: 'messages',
          model: 'claude-sonnet-4',
          system: 's',
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          max_tokens: 1
        },
        { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
      )
    ).rejects.toMatchObject<Partial<ZenMessagesError>>({ name: 'ZenMessagesError', message: 'http_418', status: 418 });
  });

  it('handles non-JSON success bodies without throwing', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: 'not-json'
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBeNull();
    expect(result.responseId).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('ignores non-numeric usage tokens', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-3',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: '1', output_tokens: 2 }
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.usage).toEqual({ inputTokens: undefined, outputTokens: 2, totalTokens: undefined });
  });

  it('treats non-numeric output_tokens as undefined', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-4',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: '2' }
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: undefined, totalTokens: undefined });
  });

  it('collects deeply nested text fields across text/content/value/completion/output', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg-deep',
        text: { text: 'top-text' },
        content: {
          text: { text: 'nested-text' },
          content: { text: 'nested-content' },
          value: ' value-one ',
          completion: '   ',
          output_text: ' output-one ',
          message: { text: ' message-one ' },
          choices: [{ content: ' choice-one ' }],
          output: [{ text: ' output-two ' }]
        },
        message: { completion: ' completion-one ' },
        choices: [{ value: ' value-two ' }],
        output: [{ output_text: ' output-three ' }]
      })
    }));
    servers.push(server);

    const client = new ZenMessagesClient({ apiKey: 'k', baseURL: server.baseURL });
    const result = await client.request(
      {
        endpoint: 'messages',
        model: 'claude-sonnet-4',
        system: 's',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    const parts = result.outputText?.split('\n') ?? [];
    expect(parts).toEqual(
      expect.arrayContaining([
        'nested-text',
        'nested-content',
        'value-one',
        'output-one',
        'message-one',
        'choice-one',
        'output-two',
        'completion-one',
        'value-two',
        'output-three'
      ])
    );
  });
});
