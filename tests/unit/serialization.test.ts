import { describe, expect, it } from 'vitest';

import { safeParseJSON, safeParseJsonBody } from '../../src/utils/serialization.js';

describe('safeParseJSON', () => {
  it('returns null for non-string input', () => {
    expect(safeParseJSON(null)).toBeNull();
    expect(safeParseJSON(undefined)).toBeNull();
  });

  it('returns null for empty/whitespace strings', () => {
    expect(safeParseJSON('')).toBeNull();
    expect(safeParseJSON('   \n\t')).toBeNull();
  });

  it('parses raw JSON', () => {
    expect(safeParseJSON('{"ok":true}')).toEqual({ ok: true });
  });

  it('parses fenced JSON blocks', () => {
    expect(safeParseJSON('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('parses inline fenced blocks without newlines', () => {
    expect(safeParseJSON('```{"ok":true}```')).toEqual({ ok: true });
  });

  it('extracts JSON substring from mixed output', () => {
    expect(safeParseJSON('prefix\n{"ok":true}\npostfix')).toEqual({ ok: true });
  });

  it('extracts array JSON substring from mixed output', () => {
    expect(safeParseJSON('prefix [1,2,3] postfix')).toEqual([1, 2, 3]);
  });

  it('returns null when no complete JSON substring exists', () => {
    expect(safeParseJSON('prefix {"ok":true')).toBeNull();
  });

  it('returns null when extracted JSON substring is not valid JSON', () => {
    expect(safeParseJSON('prefix {not-json} postfix')).toBeNull();
  });

  it('returns null when a fenced block has no closing fence and no JSON substring', () => {
    expect(safeParseJSON('```json\nnot-json')).toBeNull();
  });

  it('returns null when no JSON-like tokens exist in output', () => {
    expect(safeParseJSON('hello world')).toBeNull();
  });

  it('falls back to JSON substring when a fenced block is present but invalid', () => {
    expect(safeParseJSON('```json\nnot-json\n```\n{"ok":true}')).toEqual({ ok: true });
  });
});

describe('safeParseJsonBody', () => {
  it('treats blank and non-string bodies as empty rather than failed', () => {
    expect(safeParseJsonBody(null)).toEqual({ parsed: null, failed: false });
    expect(safeParseJsonBody('   \n\t')).toEqual({ parsed: null, failed: false });
  });

  it('parses exact JSON bodies', () => {
    expect(safeParseJsonBody(' {"ok":true} ')).toEqual({ parsed: { ok: true }, failed: false });
  });

  it('marks invalid or mixed-content bodies as failed', () => {
    expect(safeParseJsonBody('not-json')).toEqual({ parsed: null, failed: true });
    expect(safeParseJsonBody('prefix {"ok":true} postfix')).toEqual({ parsed: null, failed: true });
  });
});
