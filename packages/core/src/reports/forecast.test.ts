import { describe, expect, it } from 'vitest';
import { DEMAND_WINDOW_DAYS, monthBefore, movements, reorderFor, yearBefore, type ForecastInput } from './forecast';

/** 90 packs over the 90-day window is one a day — an easy number to reason about. */
const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  onHand: 100, inTransit: 0, soldTrailing: '90', soldSeasonal: null, basis: 'TRAILING',
  leadTimeDays: 45, safetyCoverDays: 21, ...over,
});

describe('the reorder recommendation (RPT-004..006, RPT-011)', () => {
  it('RPT-006: the projection is today plus the lead time, not what is in the warehouse now', () => {
    // A pack a day for 45 days leaves 55 of the 100 held; 21 days of cover wants 21.
    expect(reorderFor(input())).toMatchObject({ perDay: '1.000', projectedAtArrival: 55, safetyLevel: 21, suggested: 0 });
  });

  it('RPT-004: where the projection falls below the safety level, the shortfall is the suggestion', () => {
    // 30 held, a pack a day, 45 days to wait: 15 short before the cushion is counted at all.
    expect(reorderFor(input({ onHand: 30 }))).toMatchObject({ projectedAtArrival: -15, safetyLevel: 21, suggested: 36 });
  });

  it('RPT-004: stock already on the water counts — it is ordered, it is just not here', () => {
    expect(reorderFor(input({ onHand: 30, inTransit: 40 }))).toMatchObject({ projectedAtArrival: 25, suggested: 0 });
    // Not quite enough on the water still leaves something to order.
    expect(reorderFor(input({ onHand: 30, inTransit: 10 })).suggested).toBe(26);
  });

  it('RPT-002, EXP-008: seasonal where a year of history exists, trailing where it does not', () => {
    const seasonal = reorderFor(input({ basis: 'SEASONAL', soldSeasonal: '180' }));
    expect(seasonal).toMatchObject({ basisUsed: 'SEASONAL', perDay: '2.000', guide: false });
    // The same request without a season behind it quietly falls back, and says so.
    expect(reorderFor(input({ basis: 'SEASONAL' }))).toMatchObject({ basisUsed: 'TRAILING', perDay: '1.000', guide: true });
  });

  it('RPT-011: without a year of history the figure is a guide, whatever basis was asked for', () => {
    expect(reorderFor(input()).guide).toBe(true);
    expect(reorderFor(input({ soldSeasonal: '90' })).guide).toBe(false);
  });

  it('EXP-003 inverted: ordering conservatively means the faster rate, not the slower', () => {
    // Expiry asks "will this clear?" and takes the slower rate. Ordering asks "will I run
    // out?", where the expensive mistake is the opposite one.
    const busySeason = reorderFor(input({ basis: 'CONSERVATIVE', soldSeasonal: '180' }));
    expect(busySeason.perDay).toBe('2.000');
    const quietSeason = reorderFor(input({ basis: 'CONSERVATIVE', soldSeasonal: '45' }));
    expect(quietSeason.perDay).toBe('1.000');
  });

  it('RPT-004: a SKU that does not sell is never reordered', () => {
    expect(reorderFor(input({ soldTrailing: '0' }))).toMatchObject({ perDay: '0.000', safetyLevel: 0, suggested: 0 });
  });

  it('RPT-006: the window is long enough that one slow fortnight does not drive an order', () => {
    expect(DEMAND_WINDOW_DAYS).toBe(90);
  });
});

describe('sales trends (RPT-001, RPT-002)', () => {
  const points = [
    { period: '2025-09', packs: 100, revenue: '10000.00' },
    { period: '2026-08', packs: 200, revenue: '20000.00' },
    { period: '2026-09', packs: 150, revenue: '25000.00' },
  ];

  it('RPT-001: month on month compares with the month before', () => {
    const [, , september] = movements(points, 'PREVIOUS');
    expect(september).toMatchObject({ period: '2026-09', against: '2026-08', revenueChange: '25.0', packsChange: '-25.0' });
  });

  it('RPT-002: year on year compares with the same month last season', () => {
    const [, , september] = movements(points, 'YEAR_AGO');
    expect(september).toMatchObject({ period: '2026-09', against: '2025-09', revenueChange: '150.0', packsChange: '50.0' });
  });

  it('RPT-001: a period with nothing behind it reports no change, not infinite growth', () => {
    const [first] = movements(points, 'PREVIOUS');
    expect(first).toMatchObject({ period: '2025-09', against: null, revenueChange: null, packsChange: null });
  });

  it('the month and year before roll over correctly', () => {
    expect(monthBefore('2026-01')).toBe('2025-12');
    expect(monthBefore('2026-09')).toBe('2026-08');
    expect(yearBefore('2026-01')).toBe('2025-01');
  });
});
