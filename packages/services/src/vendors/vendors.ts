import {
  cleanName, countryCode, DomainError, normaliseEmail, normalisePhone, normaliseVendorCode, type VendorId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gt, ilike, or, type SQL } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx, type Patch } from '../context';
import {
  audit, decodeCursor, encodeCursor, inTx, likePattern, mapUniqueViolations, pageLimit, snapshot,
} from '../platform';
import { getDb } from '../runtime';

const { vendors } = schema;

/** VEN-001: the seven fields of a vendor profile. */
export type Vendor = {
  readonly id: VendorId;
  readonly code: string;
  readonly name: string;
  readonly address: string | null;
  readonly contactPerson: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly country: string;
  readonly isActive: boolean;
  readonly version: number;
};

const columns = {
  id: vendors.id, code: vendors.code, name: vendors.name, address: vendors.address, contactPerson: vendors.contactPerson,
  phone: vendors.phone, email: vendors.email, country: vendors.country, isActive: vendors.isActive, version: vendors.version,
};
const toVendor = (row: { id: string } & Omit<Vendor, 'id'>): Vendor => ({ ...row, id: row.id as VendorId });
const duplicateCode = new DomainError('DUPLICATE_CODE', { field: 'code' });

type Fields = {
  name: string; country: string;
  address?: string | null | undefined; contactPerson?: string | null | undefined;
  phone?: string | null | undefined; email?: string | null | undefined;
};

const optional = (value: string | null | undefined, field: string, max = 500) => (value?.trim() ? cleanName(value, field, max) : null);

function clean(input: Fields) {
  return {
    name: cleanName(input.name, 'name', 200),
    country: countryCode(input.country),
    address: optional(input.address, 'address'),
    contactPerson: optional(input.contactPerson, 'contactPerson', 200),
    // Vendors are abroad as often as not: Saudi numbers in any local form, others with their country code.
    phone: input.phone?.trim() ? normalisePhone(input.phone) : null,
    email: input.email?.trim() ? normaliseEmail(input.email) : null,
  };
}

/** VEN-003/005: readable by anyone granted vendor access. */
export async function listVendors(
  ctx: Ctx,
  filter: { search?: string | undefined; isActive?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: Vendor[]; nextCursor: string | null }> {
  authorize(ctx, 'vendors.view');
  const limit = pageLimit(filter.limit);
  const where: SQL[] = [];
  if (filter.isActive !== undefined) where.push(eq(vendors.isActive, filter.isActive));
  if (filter.search) {
    const q = likePattern(filter.search);
    where.push(or(ilike(vendors.code, q), ilike(vendors.name, q), ilike(vendors.contactPerson, q)) as SQL);
  }
  if (filter.cursor) where.push(gt(vendors.code, decodeCursor(filter.cursor, 1)[0] ?? ''));
  const rows = await getDb().select(columns).from(vendors).where(and(...where)).orderBy(asc(vendors.code)).limit(limit + 1);
  const page = rows.slice(0, limit).map(toVendor);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > limit && last ? encodeCursor([last.code]) : null };
}

export async function getVendor(ctx: Ctx, id: string): Promise<Vendor> {
  authorize(ctx, 'vendors.view');
  const [row] = await getDb().select(columns).from(vendors).where(eq(vendors.id, id));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'vendor', id });
  return toVendor(row);
}

/**
 * Picking a vendor on a product or an order needs the codes, not the
 * profiles, so product editors and buyers get them without vendor access (VEN-005).
 */
export async function listVendorCodes(ctx: Ctx): Promise<{ id: VendorId; code: string }[]> {
  authorizeAny(ctx, ['vendors.view', 'catalogue.manage_products', 'procurement.manage_po']);
  const rows = await getDb().select({ id: vendors.id, code: vendors.code }).from(vendors).where(eq(vendors.isActive, true)).orderBy(asc(vendors.code));
  return rows.map((r) => ({ id: r.id as VendorId, code: r.code }));
}

/** Workflow B (VEN-001/002): Admin and Super Admin (OQ-013). */
export async function createVendor(ctx: Ctx, input: Fields & { code: string }): Promise<Vendor> {
  authorize(ctx, 'vendors.manage');
  const values = { code: normaliseVendorCode(input.code), ...clean(input) };
  return inTx(ctx, async (tx) => {
    const [row] = await mapUniqueViolations(
      tx.insert(vendors).values({ ...values, createdBy: ctx.user.id, updatedBy: ctx.user.id }).returning(columns),
      { vendors_code_unique: duplicateCode },
    );
    if (!row) throw new Error('vendor insert returned nothing');
    await audit(tx, ctx, { action: 'vendors.vendor_created', entityType: 'vendor', entityId: row.id, after: values });
    return toVendor(row);
  });
}

/** The code is the vendor's identity on every product that names it, so it cannot change. */
export async function updateVendor(
  ctx: Ctx, id: string, input: Patch<Fields> & { version: number; isActive?: boolean | undefined },
): Promise<Vendor> {
  authorize(ctx, 'vendors.manage');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select(columns).from(vendors).where(eq(vendors.id, id));
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'vendor', id });
    const next = {
      ...clean({
        name: input.name ?? current.name, country: input.country ?? current.country,
        address: input.address === undefined ? current.address : input.address,
        contactPerson: input.contactPerson === undefined ? current.contactPerson : input.contactPerson,
        phone: input.phone === undefined ? current.phone : input.phone,
        email: input.email === undefined ? current.email : input.email,
      }),
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await tx.update(vendors)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(vendors.id, id), eq(vendors.version, input.version)))
      .returning(columns);
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'vendor', id });
    await audit(tx, ctx, { action: 'vendors.vendor_updated', entityType: 'vendor', entityId: id, before: snapshot(current, next), after: next });
    return toVendor(row);
  });
}
