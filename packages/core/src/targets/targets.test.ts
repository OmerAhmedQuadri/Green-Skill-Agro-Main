import { describe, expect, it } from 'vitest';
import { money } from '../numeric';
import {
  assertGoals, attributedPeriod, commissionFor, daysInPeriod, elapsedInPeriod, freezesAt, isBehindPace, isFrozen, settledByPeriod, targetProgress,
  type TargetActuals, type TargetGoals,
} from './targets';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as { code?: string }).code; } };
const actuals = (over: Partial<TargetActuals> = {}): TargetActuals =>
  ({ REVENUE: '0', PACKS_SOLD: '0', NEW_STORES: '0', COLLECTED: '0', ...over });

describe('monthly targets (TGT-001..006)', () => {
  it('TGT-003: only the figures the manager set are judged', () => {
    const goals: TargetGoals = { REVENUE: '50000', NEW_STORES: '4' };
    const progress = targetProgress(goals, actuals({ REVENUE: '60000', NEW_STORES: '4', PACKS_SOLD: '900' }));
    expect(progress.metrics.map((m) => m.metric)).toEqual(['REVENUE', 'NEW_STORES']);
    expect(progress.metrics[0]).toMatchObject({ goal: '50000', actual: '60000', achievement: '120.0', met: true });
    expect(progress.met).toBe(true);
  });

  it('OQ-023: the month is met only where every figure set reached its goal', () => {
    const goals: TargetGoals = { REVENUE: '50000', NEW_STORES: '4', COLLECTED: '40000' };
    const strong = targetProgress(goals, actuals({ REVENUE: '90000', NEW_STORES: '3', COLLECTED: '80000' }));
    // Two figures far over does not carry the third — the seller missed the month.
    expect(strong.metrics.map((m) => m.met)).toEqual([true, false, true]);
    expect(strong.met).toBe(false);
    expect(targetProgress(goals, actuals({ REVENUE: '50000', NEW_STORES: '4', COLLECTED: '40000' })).met).toBe(true);
  });

  it('TGT-003: a target must set at least one figure, and every figure set must be positive', () => {
    expect(code(() => assertGoals({}))).toBe('TARGET_EMPTY');
    expect(code(() => assertGoals({ REVENUE: '0' }))).toBe('TARGET_NOT_POSITIVE');
    expect(code(() => assertGoals({ REVENUE: '50000', PACKS_SOLD: '1200' }))).toBe('NO_ERROR');
  });

  it('TGT-004: achievement is reported beyond 100% — a seller may reach 140% of a goal', () => {
    const progress = targetProgress({ REVENUE: '50000' }, actuals({ REVENUE: '70000' }));
    expect(progress.metrics[0]?.achievement).toBe('140.0');
  });

  it('TGT-006: pace flags a seller below the threshold share of the month elapsed', () => {
    const goals: TargetGoals = { REVENUE: '30000' };
    const behind = targetProgress(goals, actuals({ REVENUE: '10000' })); // 33.3%
    const ahead = targetProgress(goals, actuals({ REVENUE: '14000' })); // 46.7%
    // Halfway through a 30-day month at 80%: below 40% of the goal is behind.
    expect(isBehindPace(behind, 15, 30, 80)).toBe(true);
    expect(isBehindPace(ahead, 15, 30, 80)).toBe(false);
    // Early in the month almost nobody is behind; on the last day pace is no longer the question.
    expect(isBehindPace(behind, 1, 30, 80)).toBe(false);
    expect(isBehindPace(targetProgress(goals, actuals()), 30, 30, 80)).toBe(false);
  });

  it('TGT-002: periods are Riyadh calendar months', () => {
    expect(daysInPeriod('2026-02')).toBe(28);
    expect(daysInPeriod('2028-02')).toBe(29);
    expect(daysInPeriod('2026-09')).toBe(30);
    expect(code(() => daysInPeriod('2026-13'))).toBe('INVALID_PERIOD');
    expect(elapsedInPeriod('2026-09', new Date('2026-09-20T09:00:00+03:00'))).toBe(20);
    expect(elapsedInPeriod('2026-08', new Date('2026-09-20T09:00:00+03:00'))).toBe(31); // a month gone by is fully elapsed
    expect(elapsedInPeriod('2026-10', new Date('2026-09-20T09:00:00+03:00'))).toBe(0);
  });
});

describe('closing the month and calculating commission (COM-001..009, OQ-023)', () => {
  it('OQ-023: the month freezes the configured number of days after it ends', () => {
    expect(freezesAt('2026-09', 3).toISOString()).toBe(new Date('2026-10-04T00:00:00+03:00').toISOString());
    expect(freezesAt('2026-12', 3).toISOString()).toBe(new Date('2027-01-04T00:00:00+03:00').toISOString());
    expect(isFrozen('2026-09', 3, new Date('2026-10-03T23:00:00+03:00'))).toBe(false);
    expect(isFrozen('2026-09', 3, new Date('2026-10-04T00:30:00+03:00'))).toBe(true);
  });

  it('COM-005: cash counts in the month it was received, once approved', () => {
    // Collected 31 August, approved 2 September, before August froze: August.
    expect(attributedPeriod('2026-08', '2026-09', 3, new Date('2026-09-02T10:00:00+03:00'))).toBe('2026-08');
    // The same cash approved a fortnight late, after August froze: it lands where it was found.
    expect(attributedPeriod('2026-08', '2026-09', 3, new Date('2026-09-15T10:00:00+03:00'))).toBe('2026-09');
  });

  it('COM-001..003: the rate follows the month, and the base is cash that stayed in the business', () => {
    const rates = { onTarget: '5', belowTarget: '2.5' };
    expect(commissionFor(money('80000.00'), money('0.00'), true, rates)).toMatchObject({ base: '80000.00', rate: '5', commission: '4000.00' });
    expect(commissionFor(money('80000.00'), money('0.00'), false, rates)).toMatchObject({ rate: '2.5', commission: '2000.00' });
  });

  it('COM-009: credit given away against a store\'s other debts comes out of the base', () => {
    const rates = { onTarget: '5', belowTarget: '2.5' };
    // 80,000 settled; 8,000 of credit notes went against other debts the store owed.
    expect(commissionFor(money('80000.00'), money('8000.00'), true, rates)).toMatchObject({ base: '72000.00', commission: '3600.00' });
    // More credit given away than cash settled this month: the base is nothing, never a negative commission.
    expect(commissionFor(money('1000.00'), money('4000.00'), true, rates)).toMatchObject({ base: '0.00', commission: '0.00' });
  });

  it('COM-003: a seller with no rate set has no calculated commission, which is not the same as zero', () => {
    expect(commissionFor(money('80000.00'), money('0.00'), true, null)).toEqual({ base: '80000.00', rate: null, commission: null });
  });

  it('CONVENTIONS §4: commission rounds half-up at the end, to the fils', () => {
    expect(commissionFor(money('1234.55'), money('0.00'), true, { onTarget: '3.5', belowTarget: '1' }).commission).toBe('43.21');
  });
});

describe('matching approved settlements to the cash they covered (COM-001, COM-005)', () => {
  const at = (iso: string) => new Date(`${iso}+03:00`);
  const flow = (period: string, amount: string) => ({ period, amount: money(amount) });
  const approval = (iso: string, amount: string) => ({ at: at(iso), period: iso.slice(0, 7), amount: money(amount) });
  const plain = (m: ReadonlyMap<string, string>) => Object.fromEntries(m);

  it('COM-005: settled cash carries the month the collection came in, not the month it was approved', () => {
    // 5,000 collected across the end of August, handed over and approved on 2 September.
    const settled = settledByPeriod(
      [flow('2026-08', '3000.00'), flow('2026-09', '2000.00')], [], [approval('2026-09-02T11:00:00', '5000.00')], 3,
    );
    expect(plain(settled)).toEqual({ '2026-08': '3000.00', '2026-09': '2000.00' });
  });

  it('OQ-023: cash approved after its month has frozen lands in the month it was found', () => {
    const settled = settledByPeriod(
      [flow('2026-08', '3000.00'), flow('2026-09', '2000.00')], [], [approval('2026-09-20T11:00:00', '5000.00')], 3,
    );
    expect(plain(settled)).toEqual({ '2026-09': '5000.00' });
  });

  it('COM-001: cash still in the seller\'s hands has not reached the business and earns nothing', () => {
    const settled = settledByPeriod([flow('2026-09', '5000.00')], [], [approval('2026-09-20T11:00:00', '1800.00')], 3);
    expect(plain(settled)).toEqual({ '2026-09': '1800.00' });
  });

  it('CSH-006: a settlement approved short puts only the approved amount in the base', () => {
    // Declared 1,000, approved 900: the queue gives up 900 and the rest stays with the seller.
    const settled = settledByPeriod([flow('2026-09', '1000.00')], [], [approval('2026-09-10T11:00:00', '900.00')], 3);
    expect(plain(settled)).toEqual({ '2026-09': '900.00' });
  });

  it('COM-009: cash handed back on a credit note leaves the queue first, so it is never settled', () => {
    const settled = settledByPeriod(
      [flow('2026-09', '5000.00')], [flow('2026-09', '1200.00')], [approval('2026-09-25T11:00:00', '3800.00')], 3,
    );
    expect(plain(settled)).toEqual({ '2026-09': '3800.00' });
  });

  it('COM-005: two months of collections settle oldest first, month by month', () => {
    const settled = settledByPeriod(
      [flow('2026-08', '4000.00'), flow('2026-09', '6000.00')], [],
      [approval('2026-09-01T11:00:00', '4000.00'), approval('2026-09-28T11:00:00', '6000.00')], 3,
    );
    expect(plain(settled)).toEqual({ '2026-08': '4000.00', '2026-09': '6000.00' });
  });
});
