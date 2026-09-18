import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { FEATURE_TOGGLES, parseSetting, resolveSettings, resolveToggles, SETTINGS } from './settings';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };

describe('settings register (ADR-0024)', () => {
  it('RET-005: the return windows default to thirty days', () => {
    const s = resolveSettings([]);
    expect(s['returns.uncleared_payment_window_days']).toBe(30);
    expect(s['returns.defective_window_days']).toBe(30);
  });

  it('PRC-015: a pending discount request expires after 30 minutes by default', () => {
    expect(resolveSettings([])['discount.approval_expiry_minutes']).toBe(30);
  });

  it('RET-006: stored values override defaults; each window is separate', () => {
    const s = resolveSettings([{ key: 'returns.defective_window_days', value: 14 }]);
    expect(s['returns.defective_window_days']).toBe(14);
    expect(s['returns.uncleared_payment_window_days']).toBe(30);
  });

  it('SYS-001: values are validated against their declared type and range', () => {
    expect(parseSetting('discount.order_ceiling', '12.50')).toBe('12.5');
    expect(code(() => parseSetting('discount.order_ceiling', 12.5))).toBe('INVALID_SETTING'); // never a JS number
    expect(code(() => parseSetting('discount.order_ceiling', '101'))).toBe('INVALID_SETTING');
    expect(code(() => parseSetting('returns.defective_window_days', 0))).toBe('INVALID_SETTING');
    expect(code(() => parseSetting('returns.defective_allowed', 'yes'))).toBe('INVALID_SETTING');
    expect(code(() => parseSetting('expiry.rate_basis', 'WEEKLY'))).toBe('INVALID_SETTING');
  });

  it('EXP-008: the trailing average drives expiry flags until a season of history exists', () => {
    expect(resolveSettings([])['expiry.rate_basis']).toBe('TRAILING');
  });

  it('SYS-001: an unknown or invalid stored value is ignored in favour of the default', () => {
    const s = resolveSettings([{ key: 'gone.setting', value: 1 }, { key: 'expiry.warning_days', value: 'ninety' }]);
    expect(s['expiry.warning_days']).toBe(SETTINGS['expiry.warning_days'].default);
  });

  it('SYS-005: toggles default as declared and can be switched', () => {
    expect(resolveToggles([])).toEqual(FEATURE_TOGGLES);
    expect(resolveToggles([{ key: 'stores.approval_required', enabled: false }])['stores.approval_required']).toBe(false);
  });
});
