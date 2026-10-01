import { describe, expect, it } from 'vitest';
import { businessMonth, businessMonthRange, isBusinessMonth } from './time';

describe('the business calendar (Riyadh, UTC+3)', () => {
  it('CONVENTIONS §4: a month runs from midnight Riyadh on the 1st to midnight on the next 1st', () => {
    const { from, to } = businessMonthRange('2026-09');
    expect(from.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });

  it('CONVENTIONS §4: December runs into the next year', () => {
    expect(businessMonthRange('2026-12').to.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('CONVENTIONS §4: agrees with businessMonth on a month\'s last night, when UTC is still in the old month', () => {
    const lastNight = new Date('2026-09-30T22:30:00Z'); // 01:30 on 1 October in Riyadh
    const { from, to } = businessMonthRange('2026-10');
    expect(businessMonth(lastNight)).toBe('2026-10');
    expect(lastNight >= from && lastNight < to).toBe(true);
  });

  it('CONVENTIONS §4: knows a month when it sees one', () => {
    expect(isBusinessMonth('2026-09')).toBe(true);
    for (const bad of ['2026-13', '2026-9', '26-09', '2026-09-01', '']) expect(isBusinessMonth(bad)).toBe(false);
  });
});
