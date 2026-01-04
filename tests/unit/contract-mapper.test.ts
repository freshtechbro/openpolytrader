import { describe, expect, it } from 'vitest';

import { ContractMapper } from '../../src/domain/contractMapper.js';

describe('ContractMapper', () => {
  it('enforces allowlist by returning null for unknown contracts', () => {
    const mapper = new ContractMapper([
      { canonicalId: 'c:1', venue: 'polymarket', venueContractId: 'pm:1' }
    ]);

    expect(mapper.resolve('polymarket', 'pm:1')).toBe('c:1');
    expect(mapper.resolve('kalshi', 'k:1')).toBeNull();
    expect(mapper.resolve('polymarket', 'pm:unknown')).toBeNull();
  });

  it('checks contract equivalence across venues', () => {
    const mapper = new ContractMapper([
      { canonicalId: 'c:1', venue: 'polymarket', venueContractId: 'pm:1' },
      { canonicalId: 'c:1', venue: 'kalshi', venueContractId: 'k:1' }
    ]);

    expect(
      mapper.areEquivalent(
        { venue: 'polymarket', contractId: 'pm:1' },
        { venue: 'kalshi', contractId: 'k:1' }
      )
    ).toBe(true);

    expect(
      mapper.areEquivalent(
        { venue: 'polymarket', contractId: 'pm:1' },
        { venue: 'kalshi', contractId: 'k:unknown' }
      )
    ).toBe(false);
  });
});
