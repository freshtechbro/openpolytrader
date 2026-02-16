import { describe, expect, it, vi } from 'vitest';
import { APIConnectionTimeoutError } from 'openai';

import { extractTextFromOpenAIResponse, OpenAISdkClient } from '../../src/services/llm/OpenAISdkClient.js';

describe('extractTextFromOpenAIResponse', () => {
  it('extracts text from chat content arrays', () => {
    const completion = {
      choices: [
        {
          message: {
            content: [{ type: 'text', text: '{"ok":true}' }]
          }
        }
      ]
    };

    expect(extractTextFromOpenAIResponse(completion)).toBe('{"ok":true}');
  });

  it('extracts text from responses output arrays when output_text is missing', () => {
    const response = {
      output: [
        {
          content: [{ type: 'output_text', text: 'hello' }]
        }
      ]
    };

    expect(extractTextFromOpenAIResponse(response)).toBe('hello');
  });

  it('prefers output_text when available', () => {
    const response = { output_text: '  hi  ' };

    expect(extractTextFromOpenAIResponse(response)).toBe('hi');
  });

  it('extracts nested completion and output_text fields', () => {
    const completionNested = { choices: [{ message: { completion: '  done  ' } }] };
    const outputNested = { output: [{ output_text: '  nested  ' }] };

    expect(extractTextFromOpenAIResponse(completionNested)).toBe('done');
    expect(extractTextFromOpenAIResponse(outputNested)).toBe('nested');
  });

  it('returns null for non-object inputs', () => {
    expect(extractTextFromOpenAIResponse(null)).toBeNull();
    expect(extractTextFromOpenAIResponse('hello')).toBeNull();
  });

  it('collects text from nested message and choices objects', () => {
    const response = {
      output_text: '   ',
      message: { text: { text: 'message-text' } },
      choices: [{ text: 'choice-text' }]
    };

    expect(extractTextFromOpenAIResponse(response)).toBe('message-text\nchoice-text');
  });

  it('returns null when no usable text is present', () => {
    const response = { content: [{ type: 'tool', name: 'noop' }, { text: '   ' }] };
    expect(extractTextFromOpenAIResponse(response)).toBeNull();
  });

  it('collects nested text/value/completion/output_text fields recursively', () => {
    const response = {
      text: { text: 'top-text' },
      content: {
        text: { text: 'nested-text' },
        content: { text: 'nested-content' },
        value: ' value-one ',
        completion: ' completion-one ',
        output_text: ' output-one ',
        message: { text: ' message-one ' },
        choices: [{ content: ' choice-one ' }],
        output: [{ text: ' output-two ' }]
      },
      message: { completion: ' completion-two ' },
      choices: [{ value: ' value-two ' }],
      output: [{ output_text: ' output-three ' }]
    };

    const text = extractTextFromOpenAIResponse(response);
    const parts = text?.split('\n') ?? [];

    expect(parts).toEqual(
      expect.arrayContaining([
        'nested-text',
        'nested-content',
        'value-one',
        'completion-one',
        'output-one',
        'message-one',
        'choice-one',
        'output-two',
        'completion-two',
        'value-two',
        'output-three'
      ])
    );
  });

  it('handles direct string parts and ignores blank nested string fields', () => {
    const response = {
      output: [' alpha ', '   '],
      content: [{ content: '   ', value: '   ', completion: '   ', output_text: '   ' }]
    };

    expect(extractTextFromOpenAIResponse(response)).toBe('alpha');
  });

  it('rejects messages endpoint requests', async () => {
    const client = new OpenAISdkClient({
      apiKey: 'test-key',
      baseURL: 'https://example.com',
      defaultHeaders: {},
      timeoutMs: 1000,
      maxRetries: 0
    });

    await expect(
      client.request(
        {
          endpoint: 'messages',
          model: 'gpt-4',
          system: 's',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        },
        { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
      )
    ).rejects.toThrow(/does not support messages endpoint/);
  });

  it('maps empty SDK timeout messages to the timeout fallback', async () => {
    const client = new OpenAISdkClient({
      apiKey: 'test-key',
      baseURL: 'https://example.com',
      defaultHeaders: {},
      timeoutMs: 1000,
      maxRetries: 0
    });

    const timeoutError = new APIConnectionTimeoutError();
    timeoutError.message = '';
    const responsesCreate = vi.fn().mockRejectedValue(timeoutError);
    (client as unknown as { client: unknown }).client = {
      chat: { completions: { create: vi.fn() } },
      responses: { create: responsesCreate }
    };

    await expect(
      client.request(
        {
          endpoint: 'responses',
          model: 'gpt-4o-mini',
          input: 'ping'
        },
        { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
      )
    ).rejects.toThrow('timeout');
  });

  it('handles non-object responses payloads without usage metadata', async () => {
    const client = new OpenAISdkClient({
      apiKey: 'test-key',
      baseURL: 'https://example.com',
      defaultHeaders: {},
      timeoutMs: 1000,
      maxRetries: 0
    });

    (client as unknown as { client: unknown }).client = {
      chat: { completions: { create: vi.fn() } },
      responses: { create: vi.fn().mockResolvedValue('raw-response') }
    };

    const result = await client.request(
      {
        endpoint: 'responses',
        model: 'gpt-4o-mini',
        input: 'ping'
      },
      { timeoutMs: 1000, maxRetries: 0, attempt: 1 }
    );

    expect(result.outputText).toBeNull();
    expect(result.usage).toBeUndefined();
  });
});
