import { describe, expect, it } from 'vitest';

import { getDefaultRecoveryAction, getDefaultSeverity } from '../../src/domain/incident.js';

describe('incident defaults', () => {
  it('maps representative severities by incident reason', () => {
    expect(getDefaultSeverity('auth_failure')).toBe('critical');
    expect(getDefaultSeverity('order_timeout')).toBe('high');
    expect(getDefaultSeverity('book_stale')).toBe('medium');
    expect(getDefaultSeverity('unknown')).toBe('low');
  });

  it('maps representative recovery actions by incident reason', () => {
    expect(getDefaultRecoveryAction('auth_failure')).toBe('pause');
    expect(getDefaultRecoveryAction('unwind_failed')).toBe('block');
    expect(getDefaultRecoveryAction('unknown')).toBe('alert_only');
    expect(getDefaultRecoveryAction('order_failed')).toBe('quarantine');
  });
});
