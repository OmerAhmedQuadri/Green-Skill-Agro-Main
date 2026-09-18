import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anOkra } from '../../test/catalogue';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { createVendor, getVendor, listVendorCodes, listVendors, updateVendor } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const manager = async (grants: PermissionCode[] = []) =>
  ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const full = {
  code: 'ven-7k4m', name: 'Seed House', address: 'Plot 12, Pune', contactPerson: 'A. Kumar',
  phone: '+919812345678', email: 'Sales@SeedHouse.example', country: 'in',
};

describe('vendor register (VEN-001..005)', () => {
  it('VEN-001: a vendor profile holds all seven fields, normalised', async () => {
    const vendor = await createVendor(await ctxFor(await anAccount('ADMIN')), full);
    expect(vendor).toMatchObject({
      code: 'VEN-7K4M', name: 'Seed House', address: 'Plot 12, Pune', contactPerson: 'A. Kumar',
      phone: '+919812345678', email: 'sales@seedhouse.example', country: 'IN',
    });
  });

  it('VEN-001: a Saudi number in local form is stored in E.164; codes are unique', async () => {
    const ctx = await ctxFor(await anAccount('ADMIN'));
    expect((await createVendor(ctx, { code: 'VEN-2', name: 'Agent', country: 'NL', phone: '050 123 4567' })).phone).toBe('+966501234567');
    expect(await code(createVendor(ctx, { code: 'ven-2', name: 'Other', country: 'NL' }))).toBe('DUPLICATE_CODE');
    expect(await code(createVendor(ctx, { code: 'VEN-3', name: 'Other', country: 'Holland' }))).toBe('INVALID_COUNTRY');
  });

  it('VEN-002: vendors are created and edited by Admin and Super Admin, never by a manager', async () => {
    expect(await code(createVendor(await ctxFor(await anAccount('SUPER_ADMIN')), { ...full, code: 'VEN-A' }))).toBe('NO_ERROR');
    const vendor = await createVendor(await ctxFor(await anAccount('ADMIN')), { ...full, code: 'VEN-B' });
    const withView = await manager(['vendors.view']);
    expect(await code(createVendor(withView, { ...full, code: 'VEN-C' }))).toBe('FORBIDDEN');
    expect(await code(updateVendor(withView, vendor.id, { version: vendor.version, name: 'X' }))).toBe('FORBIDDEN');
  });

  it('VEN-003: a manager reads vendors only when granted vendors.view', async () => {
    const vendor = await createVendor(await ctxFor(await anAccount('ADMIN')), full);
    expect(await code(getVendor(await manager(), vendor.id))).toBe('FORBIDDEN');
    expect((await getVendor(await manager(['vendors.view']), vendor.id)).code).toBe('VEN-7K4M');
    expect((await listVendors(await manager(['vendors.view']), { search: 'seed' })).items).toHaveLength(1);
  });

  it('VEN-004: a product references its vendor by code; the code picker needs no vendor access', async () => {
    const ctx = await ctxFor(await anAccount('ADMIN'));
    const { product, vendor } = await anOkra(ctx);
    expect(product.vendor).toEqual({ id: vendor.id, code: vendor.code });
    const productEditor = await manager(['catalogue.manage_products']);
    expect((await listVendorCodes(productEditor)).map((v) => v.code)).toContain(vendor.code);
    expect(await code(listVendorCodes(await manager(['catalogue.view'])))).toBe('FORBIDDEN');
  });

  it('VEN-005: without vendor access the code is shown, but the profile behind it is refused', async () => {
    const ctx = await ctxFor(await anAccount('ADMIN'));
    const { product } = await anOkra(ctx);
    const viewer = await manager(['catalogue.view']);
    const { getProduct } = await import('../catalogue');
    const seen = await getProduct(viewer, product.id);
    expect(seen.vendor?.code).toBe(product.vendor?.code);
    expect(await code(getVendor(viewer, seen.vendor?.id ?? ''))).toBe('FORBIDDEN');
  });

  it('SYS-009: vendor changes are audited; the code cannot change', async () => {
    const ctx = await ctxFor(await anAccount('ADMIN'));
    const vendor = await createVendor(ctx, full);
    const updated = await updateVendor(ctx, vendor.id, { version: vendor.version, contactPerson: 'B. Singh', isActive: false });
    expect(updated).toMatchObject({ code: 'VEN-7K4M', contactPerson: 'B. Singh', isActive: false });
    const rows = await ownerQuery<{ action: string }>(`select action from audit_log where entity_id = $1 order by occurred_at`, [vendor.id]);
    expect(rows.map((r) => r.action)).toEqual(['vendors.vendor_created', 'vendors.vendor_updated']);
  });
});
