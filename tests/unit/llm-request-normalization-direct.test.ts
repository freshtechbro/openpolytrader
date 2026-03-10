import { describe, expect, it } from 'vitest';

import {
  buildBackupRequest,
  normalizeOptionalModelId,
  normalizeRequestForProvider
} from '../../src/services/llm/LLMRequestNormalization.js';

describe('LLMRequestNormalization', () => {
  it('normalizes optional model ids and converts zen gpt-5 requests to responses', () => {
    expect(normalizeOptionalModelId(undefined)).toBeNull();
    expect(normalizeOptionalModelId('   ')).toBeNull();
    expect(normalizeOptionalModelId('  kimi-k2.5  ')).toBe('kimi-k2.5');

    const request = normalizeRequestForProvider('opencode-zen', {
      endpoint: 'chat.completions',
      model: 'openai/gpt-5-nano',
      temperature: 0,
      top_p: 1,
      max_tokens: 64,
      messages: [
        { role: 'developer', content: 'Return JSON.' },
        { role: 'user', content: 'score this' }
      ]
    });

    expect(request).toEqual({
      endpoint: 'responses',
      model: 'gpt-5-nano',
      instructions: 'Return JSON.',
      input: 'score this',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 64
    });
  });

  it('keeps removed legacy zen aliases as plain model ids', () => {
    const request = normalizeRequestForProvider('openrouter', {
      endpoint: 'chat.completions',
      model: 'grok-code',
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(request).toEqual({
      endpoint: 'chat.completions',
      model: 'grok-code',
      messages: [{ role: 'user', content: 'hello' }]
    });
  });

  it('normalizes openrouter message requests and infers backup endpoints', () => {
    const openRouterRequest = normalizeRequestForProvider('openrouter', {
      endpoint: 'messages',
      model: 'claude-3-5-sonnet',
      system: 'Be terse',
      temperature: 0,
      top_p: 1,
      max_tokens: 120,
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(openRouterRequest).toEqual({
      endpoint: 'chat.completions',
      model: 'claude-3-5-sonnet',
      temperature: 0,
      top_p: 1,
      max_tokens: 120,
      messages: [
        { role: 'developer', content: 'Be terse' },
        { role: 'user', content: 'hello' }
      ]
    });

    const backupMessages = buildBackupRequest(
      {
        endpoint: 'chat.completions',
        model: 'qwen/qwen3-coder',
        max_tokens: 40,
        messages: [
          { role: 'developer', content: 'Summarize.' },
          { role: 'user', content: 'latest signal' }
        ]
      },
      'claude-3-5-sonnet'
    );
    expect(backupMessages).toEqual({
      endpoint: 'messages',
      model: 'claude-3-5-sonnet',
      system: 'Summarize.',
      messages: [{ role: 'user', content: 'latest signal' }],
      max_tokens: 40,
      temperature: undefined,
      top_p: undefined
    });

    const backupResponses = buildBackupRequest(
      {
        endpoint: 'messages',
        model: 'claude-3-5-sonnet',
        system: 'Be terse',
        max_tokens: 120,
        temperature: 0,
        top_p: 1,
        messages: [{ role: 'user', content: 'hello' }]
      },
      'gpt-5-nano'
    );
    expect(backupResponses).toEqual({
      endpoint: 'responses',
      model: 'gpt-5-nano',
      instructions: 'Be terse',
      input: 'hello',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 120
    });
  });
});
