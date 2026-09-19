import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { moduleOf, PERMISSION_CODES, type PermissionCode } from './permission-catalogue';
import {
  assertCanChangePermissions, assertCanManageAccount, configurableFor, effectivePermissions, grantFor,
} from './permissions';
import { ROLES } from './roles';
import { PRESET_DEFAULTS, presetOverrides } from './presets';

const none = new Map<PermissionCode, boolean>();
const FIELD: PermissionCode[] = ['attendance.self', 'inventory.confirm_load', 'inventory.declare_closing_stock', 'cash.submit_settlement'];
const errorCode = (fn: () => void) => { try { fn(); } catch (e) { return (e as DomainError).code; } return undefined; };

describe('permission catalogue', () => {
  it('USR-009: 60 unique module.action codes', () => {
    expect(PERMISSION_CODES).toHaveLength(60);
    expect(new Set(PERMISSION_CODES).size).toBe(60);
    for (const code of PERMISSION_CODES) expect(code).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('USR-002: Super Admin holds every matrix permission, but not field self-service', () => {
    const sa = effectivePermissions('SUPER_ADMIN', none);
    expect(sa.size).toBe(56);
    for (const code of FIELD) expect(sa.has(code)).toBe(false);
  });

  it('USR-003: Admin holds everything Super Admin does except managing admin accounts', () => {
    const sa = effectivePermissions('SUPER_ADMIN', none);
    const admin = effectivePermissions('ADMIN', none);
    expect([...sa].filter((c) => !admin.has(c))).toEqual(['users.manage_admins']);
    expect(admin.has('vendors.manage')).toBe(true); // OQ-013
  });

  it('USR-005: a new manager holds only the always-on permissions until granted more', () => {
    expect([...effectivePermissions('MANAGER', none)].sort()).toEqual([
      'inventory.view_own_vehicle', 'sales.apply_discount', 'sales.confirm_dispatch_receipt',
      'sales.record', 'sales.request_dispatch', 'stores.onboard', 'stores.set_credit_cycle', 'targets.view_own',
    ]);
  });

  it('USR-007: a manager can be allowed to view stock without issuing it', () => {
    const m = effectivePermissions('MANAGER', new Map([['inventory.view_all_stock', true]]));
    expect(m.has('inventory.view_all_stock')).toBe(true);
    expect(m.has('inventory.issue_to_vehicle')).toBe(false);
  });

  it('CNV-009, TGT-004: sellers submit write-offs, process returns and see commission by default; conversion is off', () => {
    const s = effectivePermissions('SELLER', none);
    expect(s.has('inventory.submit_write_off')).toBe(true);
    expect(s.has('returns.process')).toBe(true);
    expect(s.has('targets.view_commission')).toBe(true);
    expect(s.has('inventory.convert')).toBe(false);
    expect(effectivePermissions('SELLER', new Map([['inventory.convert', true]])).has('inventory.convert')).toBe(true);
  });

  it('USR-013: field self-service belongs to sellers only', () => {
    const s = effectivePermissions('SELLER', none);
    for (const code of FIELD) expect(s.has(code)).toBe(true);
    expect(effectivePermissions('MANAGER', none).has('attendance.self')).toBe(false);
  });

  it('overrides cannot move a FULL or NONE permission', () => {
    const s = effectivePermissions('SELLER', new Map([['sales.record', false], ['stores.approve', true]]));
    expect(s.has('sales.record')).toBe(true);
    expect(s.has('stores.approve')).toBe(false);
  });
});

describe('role tiers and ownership (scope §05)', () => {
  it('USR-001: four tiers, each holding every capability the tier below always has', () => {
    expect(ROLES).toEqual(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SELLER']);
    const everything = (role: (typeof ROLES)[number]) => effectivePermissions(role, new Map(configurableFor(role).map((c) => [c, true])));
    for (let i = 1; i < ROLES.length; i += 1) {
      const lower = ROLES[i];
      const upper = ROLES[i - 1];
      if (!lower || !upper) continue;
      const always = [...effectivePermissions(lower, none)].filter((c) => !FIELD.includes(c));
      for (const code of always) expect(everything(upper).has(code), `${upper} should hold ${code}`).toBe(true);
    }
  });

  it('USR-004: the Admin owns system configuration, vendor records and managers\' permission sets', () => {
    const admin = effectivePermissions('ADMIN', none);
    for (const code of ['system.configure', 'system.manage_templates', 'system.set_limits', 'pricing.set_discount_ceilings',
      'returns.set_rules', 'vendors.manage', 'users.manage_permissions'] as const) {
      expect(admin.has(code)).toBe(true);
    }
  });

  it('USR-006: permission modules include every module the scope names', () => {
    const modules = new Set(PERMISSION_CODES.map(moduleOf));
    for (const m of ['catalogue', 'vendors', 'inventory', 'cash', 'attendance', 'sales', 'stores', 'returns', 'reports', 'targets']) {
      expect(modules.has(m), `module ${m}`).toBe(true);
    }
  });

  it('AUD-003: only Super Admin and Admin can view the audit log', () => {
    expect(ROLES.map((r) => grantFor(r, 'system.view_audit_log'))).toEqual(['FULL', 'FULL', 'NONE', 'NONE']);
  });
});

describe('presets', () => {
  it('USR-014: applying a preset replaces every Config grant', () => {
    const overrides = presetOverrides(PRESET_DEFAULTS.WAREHOUSE);
    expect(overrides.size).toBe(configurableFor('MANAGER').length);
    const m = effectivePermissions('MANAGER', overrides);
    expect(m.has('inventory.receive_goods')).toBe(true);
    expect(m.has('sales.fulfil_dispatch')).toBe(true);
    expect(m.has('cash.approve_settlement')).toBe(false);
  });

  it('USR-014: the Operations preset grants every configurable manager permission', () => {
    const m = effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.OPERATIONS_MANAGER));
    for (const code of configurableFor('MANAGER')) expect(m.has(code)).toBe(true);
  });

  it('every preset grant is configurable for managers', () => {
    const configurable = new Set(configurableFor('MANAGER'));
    for (const grants of Object.values(PRESET_DEFAULTS)) {
      for (const code of grants) expect(configurable.has(code)).toBe(true);
    }
  });
});

describe('who may change whose access (PERMISSIONS §3.2)', () => {
  const admin = effectivePermissions('ADMIN', none);

  it('an Admin cannot manage Super Admin or Admin accounts', () => {
    expect(errorCode(() => assertCanManageAccount(admin, 'ADMIN'))).toBe('ACCOUNT_TIER_FORBIDDEN');
    expect(errorCode(() => assertCanManageAccount(admin, 'SUPER_ADMIN'))).toBe('ACCOUNT_TIER_FORBIDDEN');
    expect(() => assertCanManageAccount(admin, 'MANAGER')).not.toThrow();
  });

  it('USR-005: an Admin can grant a manager a configurable permission', () => {
    expect(() => assertCanChangePermissions(admin, 'MANAGER', new Map([['stores.approve', true]]))).not.toThrow();
  });

  it('a permission that is not Config for the role cannot be granted', () => {
    expect(errorCode(() => assertCanChangePermissions(admin, 'SELLER', new Map([['stores.approve', true]]))))
      .toBe('PERMISSION_NOT_CONFIGURABLE');
  });

  it('nobody grants a permission they do not hold', () => {
    const limited = new Set<PermissionCode>(['users.manage_permissions', 'users.manage_staff', 'catalogue.view']);
    expect(errorCode(() => assertCanChangePermissions(limited, 'MANAGER', new Map([['stores.approve', true]]))))
      .toBe('FORBIDDEN');
  });

  it('a manager cannot change anyone\'s permissions', () => {
    const manager = effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.OPERATIONS_MANAGER));
    expect(errorCode(() => assertCanChangePermissions(manager, 'SELLER', new Map([['inventory.convert', true]]))))
      .toBe('FORBIDDEN');
  });
});
