import { MEDIA_KINDS, STORED_KINDS } from '@gsa/core';
import { media } from '@gsa/contracts';
import { describe, expect, it } from 'vitest';

describe('media kinds (ARCHITECTURE §6.4, SECURITY §5)', () => {
  it('ADR-0047: the upload API takes every kind the policy knows — a kind left out of the contract is refused before the policy sees it', () => {
    expect(media.MediaKind.options).toEqual([...MEDIA_KINDS]);
  });

  it('ADR-0049: the storage API takes a period for every kind the policy governs', () => {
    expect(media.StoredKind.options).toEqual([...STORED_KINDS]);
    expect(media.SetStoragePolicyRequest.safeParse({ periods: { SELFIE: 3, DELIVERY_DOCUMENT: 'FOREVER' } }).success).toBe(true);
    expect(media.SetStoragePolicyRequest.safeParse({ periods: { NOT_A_KIND: 3 } }).success).toBe(false);
    expect(media.PreviewStoragePolicyQuery.parse({ SELFIE: '1', STOREFRONT: 'FOREVER' })).toEqual({ SELFIE: 1, STOREFRONT: 'FOREVER' });
  });
});
