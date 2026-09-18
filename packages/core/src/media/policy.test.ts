import { describe, expect, it } from 'vitest';
import { effectivePermissions, presetOverrides, PRESET_DEFAULTS } from '../identity';
import {
  canReadMedia, isPastRetention, MEDIA_KINDS, MEDIA_POLICY, mediaStorageKey, sniffContentType,
} from './policy';

const none = new Map();
const seller = effectivePermissions('SELLER', none);
const warehouse = effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.WAREHOUSE));
const sales = effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.SALES_MANAGER));

describe('media policy (SECURITY §5, DATA-MODEL §5.8)', () => {
  it('ATT-001: a seller may upload the check-in photos; a manager without check-in may not', () => {
    expect(seller.has(MEDIA_POLICY.SELFIE.upload)).toBe(true);
    expect(seller.has(MEDIA_POLICY.ODOMETER.upload)).toBe(true);
    expect(warehouse.has(MEDIA_POLICY.SELFIE.upload)).toBe(false);
  });

  it('ARCHITECTURE §6.4: selfies and odometer photos come from the live camera only', () => {
    expect(MEDIA_KINDS.filter((k) => MEDIA_POLICY[k].liveCameraOnly)).toEqual(['SELFIE', 'ODOMETER']);
  });

  it('ARCHITECTURE §6.4: slips may be a screenshot or a PDF; photos are JPEG only', () => {
    expect(MEDIA_POLICY.DEPOSIT_SLIP.contentTypes).toContain('application/pdf');
    expect(MEDIA_POLICY.SELFIE.contentTypes).toEqual(['image/jpeg']);
  });

  it('SECURITY §5: the uploader reads their own file; others need a read permission for the kind', () => {
    expect(canReadMedia('SELFIE', seller, true)).toBe(true);
    expect(canReadMedia('SELFIE', warehouse, false)).toBe(false);
    expect(canReadMedia('SELFIE', sales, false)).toBe(true); // attendance.view
  });

  it('OQ-009: selfies and odometer photos are purged after 90 days; business records are kept', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(isPastRetention('SELFIE', created, new Date('2026-03-31T23:59:59Z'))).toBe(false);
    expect(isPastRetention('SELFIE', created, new Date('2026-04-01T00:00:00Z'))).toBe(true);
    expect(isPastRetention('DEPOSIT_SLIP', created, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('ADR-0020: keys are prefixed by kind, then month', () => {
    expect(mediaStorageKey('WRITE_OFF_EVIDENCE', 'abc', 'image/jpeg', new Date('2026-09-18T22:30:00Z'))).toBe('write-off/2026-09/abc.jpg');
    // Riyadh time: 23:30 UTC on 31 Aug is already September.
    expect(mediaStorageKey('SELFIE', 'x', 'image/jpeg', new Date('2026-08-31T23:30:00Z'))).toBe('selfie/2026-09/x.jpg');
  });

  it('SECURITY §5: the real type is read from the first bytes, not trusted from the client', () => {
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffContentType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffContentType(new TextEncoder().encode('<html><script>'))).toBeNull();
  });
});
