import {
  assertCreditTerms, assertLocation, availableCreditModes, boundingBox, dec, DomainError, findDuplicates, initialStoreStatus, money,
  normaliseContactNumber, type CreditMode, type DuplicateMatch, type GeoPoint,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, between, eq, ne } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { assertOwnEvidence } from '../media';
import { notify } from '../notifications';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';
import { readSettings, readToggles } from '../system';
import { loadStore, readingAsManager, type Store } from './access';

const { stores, storeAssignments, priceLists, users } = schema;

/** What the onboarding form offers: the credit modes the Admin allows (CRD-002) and the active price lists. */
export async function storeOptions(ctx: Ctx): Promise<{
  creditModes: CreditMode[]; priceLists: { id: string; nameEn: string; nameAr: string; isBase: boolean }[]; approvalRequired: boolean;
}> {
  authorizeAny(ctx, ['stores.onboard', 'stores.edit_terms', 'stores.set_credit_cycle']);
  const db = getDb();
  const settings = await readSettings(db);
  const lists = await db.select({ id: priceLists.id, nameEn: priceLists.nameEn, nameAr: priceLists.nameAr, isBase: priceLists.isBase })
    .from(priceLists).where(eq(priceLists.isActive, true)).orderBy(asc(priceLists.nameEn));
  const toggles = await readToggles(db);
  return {
    creditModes: [...availableCreditModes(settings)],
    priceLists: lists.sort((a, b) => Number(b.isBase) - Number(a.isBase)),
    approvalRequired: toggles['stores.approval_required'],
  };
}

/** STO-008 (OQ-006): likely duplicates of a store about to be onboarded — a warning, never a block. */
export async function checkDuplicates(ctx: Ctx, input: GeoPoint & { name: string }): Promise<DuplicateMatch[]> {
  authorize(ctx, 'stores.onboard');
  return duplicatesOf(getDb(), input);
}

async function duplicatesOf(db: Executor, input: GeoPoint & { name: string }): Promise<DuplicateMatch[]> {
  const point = assertLocation(input);
  const settings = await readSettings(db);
  const thresholds = {
    radiusM: settings['stores.duplicate_radius_m'], nameRadiusM: settings['stores.duplicate_name_radius_m'],
    nameSimilarityPercent: settings['stores.duplicate_name_similarity'],
  };
  const box = boundingBox(point, Math.max(thresholds.radiusM, thresholds.nameRadiusM));
  const rows = await db.select({ id: stores.id, name: stores.name, lat: stores.latitude, lng: stores.longitude }).from(stores)
    .where(and(
      between(stores.latitude, box.minLat.toFixed(6), box.maxLat.toFixed(6)),
      between(stores.longitude, box.minLng.toFixed(6), box.maxLng.toFixed(6)),
      ne(stores.status, 'REJECTED'),
    ));
  return findDuplicates({ ...point, name: input.name }, rows.map((r) => ({ id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng) })), thresholds);
}

export type OnboardInput = {
  name: string; ownerName: string; contactNumber: string; category?: string | null | undefined;
  location: GeoPoint & { accuracyM?: number | null | undefined }; address?: string | null | undefined;
  crNumber?: string | null | undefined; vatNumber?: string | null | undefined; nationalAddress?: string | null | undefined;
  creditMode: CreditMode; creditCycleDays?: number | null | undefined; creditLimit: string; priceListId: string;
  storefrontPhotoId: string; sellerId?: string | null | undefined; acknowledgeDuplicates?: boolean | undefined;
};

const text = (v: string | null | undefined) => v?.trim() || null;

/**
 * Workflow H (STO-001..010): identity, a storefront photo from the phone,
 * coordinates captured automatically, the optional registrations, and terms
 * from the modes the Admin allows. A likely duplicate is shown first and the
 * seller confirms (STO-008). With approval on, the store waits for a manager
 * (STO-009). The onboarding seller becomes the account manager (STO-006).
 */
export async function onboardStore(ctx: Ctx, input: OnboardInput): Promise<Store> {
  authorize(ctx, 'stores.onboard');
  const name = input.name.trim();
  const ownerName = input.ownerName.trim();
  if (!name || !ownerName) throw new DomainError('INVALID_NAME');
  const contactNumber = normaliseContactNumber(input.contactNumber);
  const location = assertLocation(input.location);
  const creditLimit = money(input.creditLimit);
  if (dec(creditLimit).isNegative()) throw new DomainError('INVALID_MONEY', { value: creditLimit });
  return inTx(ctx, async (tx) => {
    const settings = await readSettings(tx);
    const cycleDays = assertCreditTerms(input.creditMode, input.creditCycleDays, availableCreditModes(settings));
    await assertOwnEvidence(tx, ctx, input.storefrontPhotoId, 'STOREFRONT');
    const [list] = await tx.select({ id: priceLists.id, active: priceLists.isActive }).from(priceLists).where(eq(priceLists.id, input.priceListId));
    if (!list) throw new DomainError('NOT_FOUND', { entity: 'price_list', id: input.priceListId });
    if (!list.active) throw new DomainError('REFERENCE_INACTIVE', { entity: 'price_list', id: input.priceListId });

    // STO-006: a seller manages what they onboard; anyone else names the seller.
    const sellerId = ctx.user.role === 'SELLER' ? ctx.user.id : input.sellerId;
    if (!sellerId) throw new DomainError('NOT_FOUND', { entity: 'seller' });
    const [seller] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, sellerId));
    if (seller?.role !== 'SELLER' || seller.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', { entity: 'seller', id: sellerId });

    const duplicates = await duplicatesOf(tx, { ...location, name });
    if (duplicates.length > 0 && !input.acknowledgeDuplicates) throw new DomainError('DUPLICATE_STORE_WARNING', { duplicates });

    const status = initialStoreStatus((await readToggles(tx))['stores.approval_required']);
    const [row] = await tx.insert(stores).values({
      name, ownerName, contactNumber, category: text(input.category),
      latitude: location.lat.toFixed(6), longitude: location.lng.toFixed(6), address: text(input.address),
      crNumber: text(input.crNumber), vatNumber: text(input.vatNumber), nationalAddress: text(input.nationalAddress),
      creditMode: input.creditMode, creditCycleDays: cycleDays, creditLimit, priceListId: input.priceListId, status,
      storefrontMediaId: input.storefrontPhotoId, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: stores.id });
    if (!row) throw new Error('store insert returned nothing');
    await tx.insert(storeAssignments).values({ storeId: row.id, sellerId, startedAt: ctx.now, assignedBy: ctx.user.id, branchId: ctx.branchId });
    if (status === 'PENDING_APPROVAL') {
      await notify(tx, ctx, { permission: 'stores.approve' }, 'STORE_PENDING_APPROVAL', { name }, `/console/stores/${row.id}`);
    }
    await audit(tx, ctx, {
      action: 'stores.onboarded', entityType: 'store', entityId: row.id,
      after: { name, status, sellerId, creditMode: input.creditMode, creditCycleDays: cycleDays, creditLimit, priceListId: input.priceListId, duplicatesAcknowledged: duplicates.map((d) => d.storeId) },
    });
    return loadStore(tx, readingAsManager(ctx), row.id);
  });
}
