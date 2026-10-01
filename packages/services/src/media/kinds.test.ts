import { MEDIA_KINDS } from '@gsa/core';
import { media } from '@gsa/contracts';
import { describe, expect, it } from 'vitest';

describe('media kinds (ARCHITECTURE §6.4, SECURITY §5)', () => {
  it('ADR-0047: the upload API takes every kind the policy knows — a kind left out of the contract is refused before the policy sees it', () => {
    expect(media.MediaKind.options).toEqual([...MEDIA_KINDS]);
  });
});
