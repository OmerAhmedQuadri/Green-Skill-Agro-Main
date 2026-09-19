import {
  assertWithinMaximum, DomainError, isFeatureToggle, isSettingKey, parseSetting, percent,
  resolveSettings, resolveToggles, SETTING_KEYS, SETTINGS,
  type FeatureToggle, type FeatureToggles, type SettingKey, type Settings,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';

const { systemSettings, featureToggles, skuDiscountCeilings, skus } = schema;

/**
 * Values are stored wrapped, as `{ "v": … }`. node-postgres already parses
 * jsonb and Drizzle parses strings once more, so a bare "12.5" would come back
 * as the number 12.5 and fail validation.
 */
const wrap = (value: unknown) => ({ v: value });
const unwrap = (stored: unknown): unknown => (stored !== null && typeof stored === 'object' && 'v' in stored ? stored.v : undefined);

export async function readSettings(db: Executor = getDb()): Promise<Settings> {
  const rows = await db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings);
  return resolveSettings(rows.map((r) => ({ key: r.key, value: unwrap(r.value) })));
}

export async function readToggles(db: Executor = getDb()): Promise<FeatureToggles> {
  return resolveToggles(await db.select({ key: featureToggles.key, enabled: featureToggles.enabled }).from(featureToggles));
}

const GOVERNING = [...new Set(SETTING_KEYS.map((k) => SETTINGS[k].permission))];
const editableBy = (ctx: Ctx) => SETTING_KEYS.filter((k) => ctx.permissions.has(SETTINGS[k].permission));

/** The settings the caller may change, with their current values (SYS-001..007). */
export async function getSettings(ctx: Ctx): Promise<{ values: Partial<Settings>; editable: SettingKey[] }> {
  authorizeAny(ctx, GOVERNING);
  const all = await readSettings(ctx.tx); // after an update, the request's transaction sees the change
  const editable = editableBy(ctx);
  return { values: Object.fromEntries(editable.map((k) => [k, all[k]])), editable };
}

/**
 * PRC-016: the order ceiling, the default item ceiling and every per-SKU
 * ceiling stay at or below the absolute maximum, whichever side moved.
 */
async function assertDiscountsConsistent(tx: Executor, settings: Settings) {
  const maximum = percent(settings['discount.absolute_maximum']);
  assertWithinMaximum(percent(settings['discount.order_ceiling']), maximum, 'discount.order_ceiling');
  assertWithinMaximum(percent(settings['discount.item_ceiling']), maximum, 'discount.item_ceiling');
  const items = await tx.select({ ceiling: skuDiscountCeilings.ceiling, code: skus.code }).from(skuDiscountCeilings)
    .innerJoin(skus, eq(skus.id, skuDiscountCeilings.skuId));
  for (const item of items) assertWithinMaximum(percent(item.ceiling), maximum, `sku:${item.code}`);
}

/** SYS-001..009: each key is governed by its own permission, and every change is audited. */
export async function updateSettings(
  ctx: Ctx, changes: readonly { key: string; value: unknown }[],
): Promise<{ values: Partial<Settings>; editable: SettingKey[] }> {
  if (changes.length === 0) throw new DomainError('INVALID_SETTING', { key: null });
  const parsed = changes.map(({ key, value }) => {
    if (!isSettingKey(key)) throw new DomainError('INVALID_SETTING', { key });
    authorize(ctx, SETTINGS[key].permission);
    return { key, value: parseSetting(key, value) };
  });
  await inTx(ctx, async (tx) => {
    const before = await readSettings(tx);
    for (const { key, value } of parsed) {
      await tx.insert(systemSettings).values({ key, value: wrap(value), updatedAt: ctx.now, updatedBy: ctx.user.id })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: wrap(value), updatedAt: ctx.now, updatedBy: ctx.user.id } });
    }
    const after = await readSettings(tx);
    if (parsed.some((p) => p.key.startsWith('discount.'))) await assertDiscountsConsistent(tx, after);
    const changed = parsed.filter((p) => before[p.key] !== after[p.key]).map((p) => p.key);
    if (changed.length) {
      await audit(tx, ctx, {
        action: 'system.settings_changed', entityType: 'system_settings', entityId: null,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      });
    }
  });
  return getSettings(ctx);
}

export async function getToggles(ctx: Ctx): Promise<FeatureToggles> {
  authorize(ctx, 'system.configure');
  return readToggles(ctx.tx);
}

/** SYS-005: a switched-off feature is hidden from everyone, whatever their permissions. */
export async function updateToggles(ctx: Ctx, changes: readonly { key: string; enabled: boolean }[]): Promise<FeatureToggles> {
  authorize(ctx, 'system.configure');
  for (const { key } of changes) if (!isFeatureToggle(key)) throw new DomainError('INVALID_SETTING', { key });
  await inTx(ctx, async (tx) => {
    const before = await readToggles(tx);
    for (const { key, enabled } of changes) {
      await tx.insert(featureToggles).values({ key, enabled, updatedAt: ctx.now, updatedBy: ctx.user.id })
        .onConflictDoUpdate({ target: featureToggles.key, set: { enabled, updatedAt: ctx.now, updatedBy: ctx.user.id } });
    }
    const changed = changes.map((c) => c.key as FeatureToggle).filter((k) => before[k] !== changes.find((c) => c.key === k)?.enabled);
    if (changed.length) {
      await audit(tx, ctx, {
        action: 'system.toggles_changed', entityType: 'feature_toggles', entityId: null,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, !before[k]])),
      });
    }
  });
  return readToggles();
}

