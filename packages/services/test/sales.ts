import type { CreditMode } from '@gsa/core';
import type { Ctx } from '../src/context';
import { setPriceListItems } from '../src/pricing';
import { decideStore } from '../src/stores';
import { aPhoto } from './media';
import { aStore, basePriceListId } from './stores';
import { aLoadedVehicle } from './vehicles';

/**
 * A seller checked in with Okra bags on their vehicle, the bag priced at
 * 90.00 on the base list, and an approved store they manage.
 */
export async function aSellingSeller(admin: Ctx, opts: { packs?: number; creditMode?: CreditMode; creditLimit?: string; creditCycleDays?: number } = {}) {
  const loaded = await aLoadedVehicle(admin, opts.packs ?? 10);
  await setPriceListItems(admin, await basePriceListId(), [{ skuId: loaded.bag.id, price: '90.00' }]);
  const created = await aStore(loaded.seller.ctx, {
    creditMode: opts.creditMode ?? 'WEEKLY', creditLimit: opts.creditLimit ?? '5000.00',
    ...(opts.creditCycleDays ? { creditCycleDays: opts.creditCycleDays } : {}),
  });
  const store = await decideStore(admin, created.id, 'approve', { version: created.version });
  return { ...loaded, store };
}

/** A fake PDF printer: the HTML it was given, as bytes that start like a PDF. */
export function aPdfRenderer(opts: { fail?: boolean } = {}) {
  const printed: string[] = [];
  return {
    printed,
    fontCss: '/* no fonts in tests */',
    render(html: string): Promise<Uint8Array> {
      if (opts.fail) return Promise.reject(new Error('chromium is not installed'));
      printed.push(html);
      return Promise.resolve(new TextEncoder().encode(`%PDF-1.7 ${html.length}`));
    },
  };
}

let vouchers = 0;

/** ADR-0047: the voucher a seller hands over — a number used nowhere else, and its photo. */
export async function aVoucher(ctx: Ctx): Promise<{ number: string; photoId: string }> {
  vouchers += 1;
  return { number: `T-${crypto.randomUUID().slice(0, 8)}-${vouchers}`, photoId: await aPhoto(ctx, 'PAYMENT_VOUCHER') };
}

/** CRD-003, ADR-0047: money taken from a store, with its voucher. */
export async function paid(ctx: Ctx, amount: string, method: 'CASH' | 'BANK_TRANSFER' = 'CASH', reference?: string) {
  return { amount, method, ...(reference ? { reference } : {}), voucher: await aVoucher(ctx) };
}
