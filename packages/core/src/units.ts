import { DomainError } from './errors';
import { Dec, dec, toQuantity, type Quantity } from './numeric';

/**
 * Stock is stored in base units — grams for weight SKUs, seeds for count SKUs —
 * and people work in whole packs (ADR-0015, STK-014). These two functions are
 * the only sanctioned conversion between the two.
 */

export type SkuUnits =
  | { readonly measure: 'WEIGHT'; readonly packWeightG: string }
  | { readonly measure: 'COUNT'; readonly packCount: number };

/** A whole number of packs. JSON-safe because it is always an integer. */
export type PackCount = number & { readonly __packCount: unique symbol };

export function packCount(value: number): PackCount {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_PACK_COUNT', { value });
  }
  return value as PackCount;
}

/** Pack size in base units. CAT-010: weight ≥ 0.1 g, or a positive seed count. */
export function packSize(sku: SkuUnits): Dec {
  if (sku.measure === 'WEIGHT') {
    const grams = dec(sku.packWeightG);
    if (grams.lt('0.1')) throw new DomainError('INVALID_PACK_SIZE', { packWeightG: sku.packWeightG });
    return grams;
  }
  if (!Number.isSafeInteger(sku.packCount) || sku.packCount <= 0) {
    throw new DomainError('INVALID_PACK_SIZE', { packCount: sku.packCount });
  }
  return new Dec(sku.packCount);
}

export function toBaseUnits(packs: PackCount, sku: SkuUnits): Quantity {
  return toQuantity(packSize(sku).times(packs));
}

/**
 * Packs held in a base-unit quantity. May be fractional — which is only legal
 * for a conversion loss leg (STK-015). Use `assertWholePacks` everywhere else.
 */
export function toPacks(quantity: Quantity, sku: SkuUnits): Dec {
  return dec(quantity).dividedBy(packSize(sku));
}

export function isWholePacks(quantity: Quantity, sku: SkuUnits): boolean {
  return toPacks(quantity, sku).isInteger();
}

/** STK-015: every operational movement is a whole number of packs. */
export function assertWholePacks(quantity: Quantity, sku: SkuUnits): void {
  if (!isWholePacks(quantity, sku)) {
    throw new DomainError('PART_PACK_NOT_ALLOWED', { quantity });
  }
}

/** A held position in packs. Internal positions are always whole packs (STK-015); anything else is a bug. */
export function packsHeld(quantity: Quantity, sku: SkuUnits): PackCount {
  const packs = toPacks(quantity, sku);
  if (!packs.isInteger()) throw new DomainError('PART_PACK_NOT_ALLOWED', { quantity });
  return packCount(packs.toNumber());
}
