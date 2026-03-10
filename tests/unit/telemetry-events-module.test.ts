import { describe, it, expect } from 'vitest';

describe('telemetry events module', () => {
  it('compiles to a type-only module with no runtime exports', async () => {
    const runtimeModule = await import('../../src/telemetry/events.js');

    expect(Object.keys(runtimeModule)).toEqual([]);
  });
});
