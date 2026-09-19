import type { Ctx } from '../src/context';
import { checkIn } from '../src/attendance';
import { getSkuStock } from '../src/inventory';
import { assignVehicle, confirmLoad, createVehicle, issueLoad } from '../src/vehicles';
import { anAccount, ctxFor } from './factories';
import { aPhoto } from './media';
import { okraInWarehouse } from './stock';

let n = 0;

/** The warehouse yard in Riyadh, and a spot a kilometre north of it. */
export const YARD = { lat: 24.7136, lng: 46.6753, accuracyM: 10 };
export const AWAY = { lat: 24.7236, lng: 46.6753, accuracyM: 10 };

export async function aSeller(now?: Date) {
  const account = await anAccount('SELLER');
  return { account, ctx: await ctxFor(account, now ? { now } : {}) };
}

/** A seller's context at a given moment — each request reads the clock when it arrives. */
export const at = (account: { id: Ctx['user']['id']; role: 'SELLER' }, now: Date) => ctxFor(account, { now });

export async function aVehicle(ctx: Ctx, odometer = 10_000) {
  n += 1;
  return createVehicle(ctx, { registration: `TST ${1000 + n}`, description: 'Pickup', odometer });
}

/** Selfie, location and — with a vehicle — odometer photo and reading, as the phone sends them. */
export async function checkInAs(ctx: Ctx, opts: { odometer?: number; location?: typeof YARD; withoutVehicle?: boolean } = {}) {
  const selfieId = await aPhoto(ctx, 'SELFIE');
  const odometerPhotoId = opts.withoutVehicle ? null : await aPhoto(ctx, 'ODOMETER');
  return checkIn(ctx, {
    location: opts.location ?? YARD, selfieId, withoutVehicle: opts.withoutVehicle,
    odometer: opts.withoutVehicle ? null : (opts.odometer ?? 10_000), odometerPhotoId,
  });
}

export const captureFor = async (ctx: Ctx, odometer: number, location = YARD) => ({
  location, selfieId: await aPhoto(ctx, 'SELFIE'), odometer, odometerPhotoId: await aPhoto(ctx, 'ODOMETER'),
});

/**
 * Okra in the warehouse, a vehicle assigned to a seller who has checked in,
 * and a load of `packs` bags issued and confirmed onto it.
 */
export async function aLoadedVehicle(admin: Ctx, packs = 5) {
  const stock = await okraInWarehouse(admin);
  const vehicle = await aVehicle(admin);
  const seller = await aSeller();
  await assignVehicle(admin, vehicle.id, { sellerId: seller.account.id });
  await checkInAs(seller.ctx);
  const [bagBatch] = (await getSkuStock(admin, stock.bag.id)).batches;
  if (!bagBatch) throw new Error('no bag batch');
  const load = await issueLoad(admin, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs }] });
  const confirmed = await confirmLoad(seller.ctx, load.id, { version: load.version });
  return { ...stock, vehicle, seller, bagBatch, load: confirmed };
}
