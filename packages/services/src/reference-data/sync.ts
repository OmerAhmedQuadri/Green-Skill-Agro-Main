import { DEFAULT_PRODUCT_TYPES, moduleOf, PERMISSION_CODES, PRESET_DEFAULTS, PRODUCT_ATTRIBUTES } from '@gsa/core';
import { type Db, schema } from '@gsa/db';
import { eq, notInArray } from 'drizzle-orm';
import { getDb } from '../runtime';

const {
  branches, warehouses, permissions, permissionPresets, permissionPresetGrants, productTypes, productTypeAttributes, priceLists,
} = schema;

/**
 * Reference data every environment needs, production included (DEVELOPMENT §7).
 * Idempotent; runs after migrations on every deploy. Presets are created once —
 * later Admin edits are preserved.
 */
export async function syncReferenceData(db: Db = getDb()) {
  return db.transaction(async (tx) => {
    // ADR-0004: one branch and one warehouse, as first-class rows.
    await tx.insert(branches)
      .values({ code: 'HQ', nameEn: 'Riyadh Head Office', nameAr: 'المكتب الرئيسي - الرياض' })
      .onConflictDoNothing({ target: branches.code });
    const [hq] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.code, 'HQ'));
    if (!hq) throw new Error('HQ branch missing after sync');
    await tx.insert(warehouses)
      .values({ branchId: hq.id, code: 'WH-01', nameEn: 'Riyadh Central Warehouse', nameAr: 'المستودع المركزي - الرياض' })
      .onConflictDoNothing({ target: warehouses.code });

    // The permission catalogue mirrors core (PERMISSIONS.md).
    const existing = new Set((await tx.select({ code: permissions.code }).from(permissions)).map((r) => r.code));
    const missing = PERMISSION_CODES.filter((code) => !existing.has(code));
    if (missing.length) await tx.insert(permissions).values(missing.map((code) => ({ code, module: moduleOf(code) })));
    const removed = await tx.delete(permissions)
      .where(notInArray(permissions.code, [...PERMISSION_CODES]))
      .returning({ code: permissions.code });

    const presetsCreated: string[] = [];
    for (const [code, grants] of Object.entries(PRESET_DEFAULTS)) {
      const created = await tx.insert(permissionPresets).values({ code, isSystem: true })
        .onConflictDoNothing().returning({ code: permissionPresets.code });
      if (created.length) {
        await tx.insert(permissionPresetGrants).values(grants.map((permission) => ({ presetCode: code, permission })));
        presetsCreated.push(code);
      }
    }
    // CAT-014: the two product types Phase 1 ships, created once. Admin edits to
    // their templates are preserved (CAT-015).
    const productTypesCreated: string[] = [];
    for (const [code, type] of Object.entries(DEFAULT_PRODUCT_TYPES)) {
      const [created] = await tx.insert(productTypes)
        .values({ code, nameEn: type.nameEn, nameAr: type.nameAr, countUnit: type.countUnit })
        .onConflictDoNothing({ target: productTypes.code }).returning({ id: productTypes.id });
      if (created) {
        await tx.insert(productTypeAttributes).values(PRODUCT_ATTRIBUTES.map((attribute) => ({
          productTypeId: created.id, attribute, mode: type.template[attribute],
        })));
        productTypesCreated.push(code);
      }
    }

    // PRC-002: exactly one base price list, which applies to every store.
    const basePriceList = await tx.insert(priceLists)
      .values({ nameEn: 'Base price list', nameAr: 'قائمة الأسعار الأساسية', isBase: true })
      .onConflictDoNothing().returning({ id: priceLists.id });

    return {
      permissionsAdded: missing.length, permissionsRemoved: removed.map((r) => r.code), presetsCreated,
      productTypesCreated, basePriceListCreated: basePriceList.length > 0,
    };
  });
}
