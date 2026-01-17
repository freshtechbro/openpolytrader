import { describe, expect, it } from 'vitest';

import { extractTextFromOpenAIResponse } from '../../src/services/llm/OpenAISdkClient.js';

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
});
