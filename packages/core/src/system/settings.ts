import { DomainError } from '../errors';
import type { PermissionCode } from '../identity';
import { dec, percent } from '../numeric';

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
  | { readonly kind: 'choice'; readonly options: readonly string[]; readonly default: string };

type Entry = Spec & { readonly permission: PermissionCode; readonly group: SettingGroup };

export const SETTING_GROUPS = ['discounts', 'returns', 'expiry', 'operations', 'attendance', 'limits'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTINGS = {
  // PRC-004..007, PRC-015, PRC-016
  'discount.order_ceiling': { kind: 'percent', default: '10', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.item_ceiling': { kind: 'percent', default: '5', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.absolute_maximum': { kind: 'percent', default: '25', permission: 'pricing.set_discount_ceilings', group: 'discounts' },
  'discount.approval_expiry_minutes': { kind: 'integer', min: 5, max: 240, default: 30, permission: 'pricing.set_discount_ceilings', group: 'discounts' },
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
  'vehicles.audit_interval_days': { kind: 'integer', min: 1, max: 365, default: 30, permission: 'system.configure', group: 'operations' },
  // ATT-012 (ADR-0032): odometer readings outside these are flagged for review, never refused
  'attendance.odometer_tolerance_km': { kind: 'integer', min: 0, max: 100, default: 5, permission: 'system.configure', group: 'attendance' },
  'attendance.max_session_km': { kind: 'integer', min: 50, max: 2000, default: 500, permission: 'system.configure', group: 'attendance' },
  // LIM-003
  'ceilings.reminder_interval_hours': { kind: 'integer', min: 1, max: 168, default: 24, permission: 'system.set_limits', group: 'limits' },
} as const satisfies Record<string, Entry>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

type ValueOf<S> = S extends { kind: 'percent' } ? string
  : S extends { kind: 'integer' } ? number
    : S extends { kind: 'boolean' } ? boolean
      : S extends { kind: 'choice'; options: readonly (infer O)[] } ? O
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
