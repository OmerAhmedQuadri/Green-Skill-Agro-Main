import { businessDate, DEMAND_WINDOW_DAYS, reorderFor, type Reorder } from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { listStock } from '../inventory';
import { inTx } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';
import { dayAfter, daysBack, packsSold, workerCtx } from './rollup';

const { reorderRecommendations, skus } = schema;

export type Recommendation = Reorder & {
  readonly skuId: string;
  readonly code: string;
  readonly product: { readonly nameEn: string; readonly nameAr: string };
  readonly variety: { readonly nameEn: string; readonly nameAr: string } | null;
  readonly onHand: number;
  readonly inTransit: number;
  readonly leadTimeDays: number;
  readonly safetyCoverDays: number;
};

/**
 * RPT-004..006, RPT-011 (ADR-0043): the reorder pass. For every SKU that has a
 * safety cover set, project stock forward to the day the next shipment would
 * land and compare against the cushion.
 *
 * A SKU with no safety cover is not forecast at all — silence is the honest
 * answer where nobody has said how much cover it needs.
 */
export async function buildRecommendations(ctx: Ctx): Promise<Recommendation[]> {
  const db = ctx.tx ?? getDb();
  const settings = await readSettings(db);
  const leadTimeDays = settings['imports.lead_time_days'];
  const basis = settings['expiry.rate_basis'];

  const forecast = await db.select({ id: skus.id, safetyCoverDays: skus.safetyCoverDays }).from(skus)
    .where(and(eq(skus.isActive, true), isNotNull(skus.safetyCoverDays)));
  if (forecast.length === 0) return [];
  const skuIds = forecast.map((s) => s.id);

  const today = businessDate(ctx.now);
  // The window ends after today, not on it: a sale made this morning is demand.
  const lastSeason = daysBack(today, 365);
  const [trailing, seasonal] = await Promise.all([
    packsSold(db, skuIds, daysBack(today, DEMAND_WINDOW_DAYS - 1), dayAfter(today)),
    // RPT-002: the same span a year ago, ending on the same date. Empty until a season exists.
    packsSold(db, skuIds, daysBack(lastSeason, DEMAND_WINDOW_DAYS - 1), dayAfter(lastSeason)),
  ]);
  const anySeasonal = [...seasonal.values()].some((packs) => packs > 0);

  const stock = await listStock(ctx, { limit: 200 });
  const bySku = new Map(stock.items.map((s) => [s.skuId as string, s]));

  const out: Recommendation[] = [];
  for (const sku of forecast) {
    const held = bySku.get(sku.id);
    if (!held) continue;
    const result = reorderFor({
      onHand: held.positions.total,
      inTransit: held.incoming.inTransit,
      soldTrailing: String(trailing.get(sku.id) ?? 0),
      // RPT-011: a year of history for the catalogue as a whole, not per SKU — a
      // SKU that genuinely sold nothing last season is a zero, not an unknown.
      soldSeasonal: anySeasonal ? String(seasonal.get(sku.id) ?? 0) : null,
      basis,
      leadTimeDays,
      safetyCoverDays: sku.safetyCoverDays ?? 0,
    });
    out.push({
      ...result,
      skuId: sku.id, code: held.code, product: held.product, variety: held.variety,
      onHand: held.positions.total, inTransit: held.incoming.inTransit,
      leadTimeDays, safetyCoverDays: sku.safetyCoverDays ?? 0,
    });
  }
  return out.sort((a, b) => b.suggested - a.suggested || a.code.localeCompare(b.code));
}

/** Stores the pass so the screen reads a figure rather than recomputing one (DATA-MODEL §6). */
export async function recordRecommendations(ctx: Ctx): Promise<{ built: number; toOrder: number }> {
  const items = await buildRecommendations(ctx);
  if (items.length === 0) return { built: 0, toOrder: 0 };
  await inTx(ctx, async (tx) => {
    await tx.insert(reorderRecommendations).values(items.map((r) => ({
      id: newId(), builtAt: ctx.now, skuId: r.skuId,
      onHand: r.onHand, inTransit: r.inTransit, perDay: r.perDay, basisUsed: r.basisUsed, guide: r.guide,
      leadTimeDays: r.leadTimeDays, safetyCoverDays: r.safetyCoverDays,
      projectedAtArrival: r.projectedAtArrival, safetyLevel: r.safetyLevel, suggestedPacks: r.suggested,
      branchId: ctx.branchId,
    }))).onConflictDoNothing();
  });
  return { built: items.length, toOrder: items.filter((r) => r.suggested > 0).length };
}

/** RPT-004: what the last pass recommended, newest first. */
export async function listRecommendations(ctx: Ctx): Promise<{ builtAt: Date | null; items: Recommendation[] }> {
  authorize(ctx, 'reports.view_forecast');
  // Recomputed on read: at Phase 1 volume it is a handful of queries, and a
  // manager deciding an import order should not be looking at last night's stock.
  const items = await buildRecommendations(ctx);
  const db = ctx.tx ?? getDb();
  const [last] = await db.select({ builtAt: reorderRecommendations.builtAt }).from(reorderRecommendations)
    .orderBy(desc(reorderRecommendations.builtAt)).limit(1);
  return { builtAt: last?.builtAt ?? null, items };
}

export const sweepForecast = async (now: Date) => recordRecommendations(await workerCtx(now));

