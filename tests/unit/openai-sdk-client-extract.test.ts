import { describe, expect, it } from 'vitest';

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
});
