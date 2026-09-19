import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../src/context';
import { getDb } from '../src/runtime';
import { onboardStore, type OnboardInput } from '../src/stores';
import { aPhoto } from './media';

let n = 0;
export const SHOP = { lat: 24.6877, lng: 46.7219 }; // a street in Riyadh

export async function basePriceListId(): Promise<string> {
  const [base] = await getDb().select({ id: schema.priceLists.id }).from(schema.priceLists).where(eq(schema.priceLists.isBase, true));
  if (!base) throw new Error('no base price list');
  return base.id;
}

/** A store onboarded as the phone does it: a storefront photo, the location, terms. Each one far from the last. */
export async function aStore(ctx: Ctx, opts: Partial<OnboardInput> = {}) {
  n += 1;
  return onboardStore(ctx, {
    name: `Test Store ${n}`, ownerName: 'Owner', contactNumber: '0501234567',
    location: { lat: SHOP.lat + n * 0.05, lng: SHOP.lng }, creditMode: 'WEEKLY', creditLimit: '1000.00',
    priceListId: await basePriceListId(), storefrontPhotoId: await aPhoto(ctx, 'STOREFRONT'),
    ...opts,
  });
}
