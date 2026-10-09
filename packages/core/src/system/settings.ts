import { DomainError } from '../errors';
import type { PermissionCode } from '../identity';
import { dec, money, percent, toMoney } from '../numeric';
import { isCalendarDate } from '../time';

/**
 * The settings register (ADR-0024). Every system-wide value an Admin can change
 * is declared here with its type, default and the permission that governs it.
 * The database stores only values that differ from the default, so a new
 * setting needs no migration and every environment starts from the same place.
 */
type Spec =
  | { readonly kind: 'percent'; readonly default: string }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number; readonly default: number }
  | { readonly kind: 'boolean'; readonly default: boolean }
  | { readonly kind: 'choice'; readonly options: readonly string[]; readonly default: string }
  // A retention period (ADR-0049): whole months within the range, or 'FOREVER' where the kind allows it.
  | { readonly kind: 'months'; readonly min: number; readonly max: number; readonly forever: boolean; readonly default: number | 'FOREVER' }
  // A calendar date, `YYYY-MM-DD`, or none.
  | { readonly kind: 'date'; readonly default: null }
  // A sum of money, a decimal string within the range (ADR-0003).
  | { readonly kind: 'money'; readonly min: string; readonly max: string; readonly default: string };

type Entry = Spec & { readonly permission: PermissionCode; readonly group: SettingGroup };

export const SETTING_GROUPS = ['discounts', 'sales', 'documents', 'returns', 'expiry', 'operations', 'attendance', 'stores', 'credit', 'limits', 'targets', 'storage'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTINGS = {
  // PRC-004..007, PRC-015, PRC-016
  'discount.order_ceiling': { kind: 'percent', default: '10', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.item_ceiling': { kind: 'percent', default: '5', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.absolute_maximum': { kind: 'percent', default: '25', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.approval_expiry_minutes': { kind: 'integer', min: 5, max: 240, default: 30, permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  // SAL-015, SAL-016 (ADR-0052): open sales on or off — the Admin's, grantable to a manager — and the sum above which one waits for approval anyway.
  'sales.open_sales_on': { kind: 'boolean', default: true, permission: 'sales.manage_open_sales', group: 'sales' },
  'sales.open_sale_limit': { kind: 'money', min: '0.00', max: '100000.00', default: '500.00', permission: 'system.configure', group: 'sales' },
  // DOC-004: whether the seller must send the delivery document, may, or cannot — a copy is kept regardless (DOC-005)
  'documents.sending': { kind: 'choice', options: ['OPTIONAL', 'COMPULSORY', 'DISABLED'], default: 'OPTIONAL', permission: 'system.configure', group: 'documents' },
  // RET-002..006, SYS-003
  'returns.uncleared_payment_allowed': { kind: 'boolean', default: true, permission: 'returns.set_rules', group: 'returns' },
  'returns.uncleared_payment_window_days': { kind: 'integer', min: 1, max: 365, default: 30, permission: 'returns.set_rules', group: 'returns' },
  'returns.defective_allowed': { kind: 'boolean', default: true, permission: 'returns.set_rules', group: 'returns' },
  'returns.defective_window_days': { kind: 'integer', min: 1, max: 365, default: 30, permission: 'returns.set_rules', group: 'returns' },
  // EXP-001, EXP-005, EXP-008, SYS-006: categories may set their own warning window
  'expiry.warning_days': { kind: 'integer', min: 1, max: 730, default: 90, permission: 'system.configure', group: 'expiry' },
  'expiry.rate_basis': { kind: 'choice', options: ['TRAILING', 'SEASONAL', 'CONSERVATIVE'], default: 'TRAILING', permission: 'system.configure', group: 'expiry' },
  // DSP-014 / SYS-007, VEH-015
  'dispatch.unconfirmed_after_days': { kind: 'integer', min: 1, max: 60, default: 5, permission: 'system.configure', group: 'operations' },
  // VEH-015, OQ-022: how long a vehicle may go without a physical audit before the dashboard says so.
  'vehicles.audit_interval_days': { kind: 'integer', min: 1, max: 365, default: 30, permission: 'system.configure', group: 'operations' },
  // RPT-004, RPT-006, OQ-023: how far ahead the reorder projection looks — imports come by the same route, so one figure serves
  'imports.lead_time_days': { kind: 'integer', min: 1, max: 365, default: 45, permission: 'system.configure', group: 'operations' },
  // ATT-012 (ADR-0032): odometer readings outside these are flagged for review, never refused
  'attendance.odometer_tolerance_km': { kind: 'integer', min: 0, max: 100, default: 5, permission: 'system.configure', group: 'attendance' },
  'attendance.max_session_km': { kind: 'integer', min: 50, max: 2000, default: 500, permission: 'system.configure', group: 'attendance' },
  // STO-008, OQ-006: likely duplicates — near, or a similar name within the wider radius
  'stores.duplicate_radius_m': { kind: 'integer', min: 10, max: 5000, default: 150, permission: 'system.configure', group: 'stores' },
  'stores.duplicate_name_radius_m': { kind: 'integer', min: 100, max: 20000, default: 1000, permission: 'system.configure', group: 'stores' },
  'stores.duplicate_name_similarity': { kind: 'integer', min: 10, max: 100, default: 60, permission: 'system.configure', group: 'stores' },
  // CRD-002: which credit modes are offered; OQ-018: days of grace after a cycle closes
  'credit.bill_to_bill_enabled': { kind: 'boolean', default: true, permission: 'system.configure', group: 'credit' },
  'credit.weekly_enabled': { kind: 'boolean', default: true, permission: 'system.configure', group: 'credit' },
  'credit.monthly_enabled': { kind: 'boolean', default: true, permission: 'system.configure', group: 'credit' },
  'credit.custom_enabled': { kind: 'boolean', default: true, permission: 'system.configure', group: 'credit' },
  'credit.grace_days': { kind: 'integer', min: 0, max: 30, default: 0, permission: 'system.configure', group: 'credit' },
  'credit.week_closes_on': {
    kind: 'choice', options: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'], default: 'SATURDAY',
    permission: 'system.configure', group: 'credit',
  },
  // TGT-006, COM-008 (ADR-0042, OQ-023): how far behind pace is worth saying so, and how long a month stays live after it ends
  'targets.pace_threshold_percent': { kind: 'integer', min: 10, max: 100, default: 80, permission: 'targets.manage', group: 'targets' },
  'period.close_after_days': { kind: 'integer', min: 0, max: 15, default: 3, permission: 'targets.manage', group: 'targets' },
  // LIM-003
  'ceilings.reminder_interval_hours': { kind: 'integer', min: 1, max: 168, default: 24, permission: 'system.set_limits', group: 'limits' },
  // SYS-010, SYS-013 (ADR-0049): how long each kind of file is kept, and the budget the usage page measures against.
  // Selfies are facial images: never forever as a kind, at most two years (OQ-009).
  'storage.keep_selfie': { kind: 'months', min: 1, max: 24, forever: false, default: 3, permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_odometer': { kind: 'months', min: 1, max: 120, forever: true, default: 3, permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_storefront': { kind: 'months', min: 1, max: 120, forever: true, default: 'FOREVER', permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_write_off_evidence': { kind: 'months', min: 1, max: 120, forever: true, default: 6, permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_deposit_slip': { kind: 'months', min: 1, max: 120, forever: true, default: 'FOREVER', permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_transport_slip': { kind: 'months', min: 1, max: 120, forever: true, default: 6, permission: 'system.manage_storage', group: 'storage' },
  'storage.keep_payment_voucher': { kind: 'months', min: 1, max: 120, forever: true, default: 'FOREVER', permission: 'system.manage_storage', group: 'storage' },
  // DOC-005: a copy of every delivery document is kept — forever unless the Super Admin decides otherwise.
  'storage.keep_delivery_document': { kind: 'months', min: 1, max: 120, forever: true, default: 'FOREVER', permission: 'system.manage_storage', group: 'storage' },
  'storage.budget_gb': { kind: 'integer', min: 1, max: 10000, default: 10, permission: 'system.manage_storage', group: 'storage' },
  // ADR-0049 (amended): how long the nightly backup keeps database backups — never under a week, whoever asks.
  'storage.backup_retention_days': { kind: 'integer', min: 7, max: 3650, default: 30, permission: 'system.manage_storage', group: 'storage' },
  // ADR-0050: the nightly backup is paused through this day; it always has an end (at most 30 days on).
  'storage.backups_paused_until': { kind: 'date', default: null, permission: 'system.manage_storage', group: 'storage' },
} as const satisfies Record<string, Entry>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

type ValueOf<S> = S extends { kind: 'percent' } ? string
  : S extends { kind: 'integer' } ? number
    : S extends { kind: 'boolean' } ? boolean
      : S extends { kind: 'choice'; options: readonly (infer O)[] } ? O
        : S extends { kind: 'months' } ? number | 'FOREVER'
          : S extends { kind: 'date' } ? string | null
            : S extends { kind: 'money' } ? string
              : never;
export type SettingValue<K extends SettingKey> = ValueOf<(typeof SETTINGS)[K]>;
export type Settings = { readonly [K in SettingKey]: SettingValue<K> };

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

/** Validates an incoming value. Percentages travel as decimal strings (ADR-0003). */
export function parseSetting<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const spec: Spec = SETTINGS[key];
  const invalid = () => new DomainError('INVALID_SETTING', { key });
  switch (spec.kind) {
    case 'percent':
      if (typeof raw !== 'string') throw invalid();
      // Canonical form, so '10.000' and '10' are the same value.
      try { return dec(percent(raw)).toString() as SettingValue<K>; } catch { throw invalid(); }
    case 'integer':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < spec.min || raw > spec.max) throw invalid();
      return raw as SettingValue<K>;
    case 'boolean':
      if (typeof raw !== 'boolean') throw invalid();
      return raw as SettingValue<K>;
    case 'choice':
      if (typeof raw !== 'string' || !spec.options.includes(raw)) throw invalid();
      return raw as SettingValue<K>;
    case 'months':
      if (raw === 'FOREVER' && spec.forever) return raw as SettingValue<K>;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < spec.min || raw > spec.max) throw invalid();
      return raw as SettingValue<K>;
    case 'date':
      if (raw === null) return raw as SettingValue<K>;
      if (typeof raw !== 'string' || !isCalendarDate(raw)) throw invalid();
      return raw as SettingValue<K>;
    case 'money': {
      if (typeof raw !== 'string') throw invalid();
      let value: string;
      // Canonical form, two places, so '750' and '750.00' are the same value.
      try { value = toMoney(dec(money(raw.trim()))); } catch { throw invalid(); }
      if (dec(value).lt(dec(spec.min)) || dec(value).gt(dec(spec.max))) throw invalid();
      return value as SettingValue<K>;
    }
  }
}

/** Stored values over defaults. A stored value that no longer validates falls back to the default. */
export function resolveSettings(stored: readonly { key: string; value: unknown }[]): Settings {
  const values: Record<string, unknown> = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default]));
  for (const { key, value } of stored) {
    if (!isSettingKey(key)) continue;
    try { values[key] = parseSetting(key, value); } catch { /* keep the default */ }
  }
  return values as Settings;
}

/**
 * Feature toggles switch a behaviour on or off for everyone, whatever their
 * permissions (PERMISSIONS §3.4). Governed by `system.configure`.
 */
export const FEATURE_TOGGLES = {
  'stores.approval_required': true, // STO-009, STO-010
  'attendance.break_logging': true, // ATT-003
  'attendance.restricted_check_in': false, // ATT-008
  'inventory.seller_conversion': false, // CNV-009
} as const satisfies Record<string, boolean>;

export type FeatureToggle = keyof typeof FEATURE_TOGGLES;
export type FeatureToggles = { readonly [K in FeatureToggle]: boolean };
export const FEATURE_TOGGLE_KEYS = Object.keys(FEATURE_TOGGLES) as FeatureToggle[];
export const isFeatureToggle = (key: string): key is FeatureToggle => Object.hasOwn(FEATURE_TOGGLES, key);

export function resolveToggles(stored: readonly { key: string; enabled: boolean }[]): FeatureToggles {
  const values: Record<string, boolean> = { ...FEATURE_TOGGLES };
  for (const { key, enabled } of stored) if (isFeatureToggle(key)) values[key] = enabled;
  return values as FeatureToggles;
}

/** CRD-002: the credit modes the Admin currently offers. */
export function availableCreditModes(settings: Settings): Set<'BILL_TO_BILL' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'> {
  const out = new Set<'BILL_TO_BILL' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'>();
  if (settings['credit.bill_to_bill_enabled']) out.add('BILL_TO_BILL');
  if (settings['credit.weekly_enabled']) out.add('WEEKLY');
  if (settings['credit.monthly_enabled']) out.add('MONTHLY');
  if (settings['credit.custom_enabled']) out.add('CUSTOM');
  return out;
}
