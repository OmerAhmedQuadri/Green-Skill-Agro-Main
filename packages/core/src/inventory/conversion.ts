import { DomainError } from '../errors';
import { Dec, dec, toQuantity, type Quantity } from '../numeric';
import { packCount, packSize, toBaseUnits, type SkuUnits } from '../units';

export type ConversionSku = {
  readonly skuId: string; readonly productId: string; readonly varietyId: string | null; readonly units: SkuUnits;
};

export type ConversionInput = {
  readonly sourcePacks?: number | null | undefined;
  readonly targetPacks?: number | null | undefined;
  /** In base units — grams or seeds — since a loss need not be a whole pack (STK-015). */
  readonly loss?: string | null | undefined;
};

export type Conversion = {
  readonly sourcePacks: number; readonly targetPacks: number;
  readonly sourceQuantity: Quantity; readonly targetQuantity: Quantity; readonly loss: Quantity;
};

/**
 * CNV-001..003, 010, 011: one function for repackaging (a 5 kg bag into 1 kg
 * pouches), for combining back, and for a change of packaging at the same
 * size. Source and target are the same product and variety, in the same
 * measure, so they share a base unit (ADR-0015) and must balance exactly:
 * source = target + loss. Enter any two; the third is derived.
 */
export function planConversion(source: ConversionSku, target: ConversionSku, input: ConversionInput): Conversion {
  if (source.skuId === target.skuId) throw new DomainError('INVALID_CONVERSION', { reason: 'SAME_SKU' });
  if (source.productId !== target.productId || source.varietyId !== target.varietyId) {
    throw new DomainError('INVALID_CONVERSION', { reason: 'DIFFERENT_VARIETY' });
  }
  if (source.units.measure !== target.units.measure) throw new DomainError('INVALID_CONVERSION', { reason: 'DIFFERENT_MEASURE' });

  const sourceSize = packSize(source.units);
  const targetSize = packSize(target.units);
  const lossText = input.loss?.trim() ?? '';
  const given = [input.sourcePacks ?? null, input.targetPacks ?? null, lossText || null].filter((v) => v !== null).length;
  if (given < 2) throw new DomainError('INVALID_CONVERSION', { reason: 'TWO_OF_THREE' });

  if (lossText && !/^\d{1,11}(\.\d{1,3})?$/.test(lossText)) throw new DomainError('INVALID_CONVERSION', { reason: 'LOSS' });
  const loss = lossText ? dec(lossText) : null;
  if (loss && (loss.isNegative() || loss.decimalPlaces() > 3)) throw new DomainError('INVALID_CONVERSION', { reason: 'LOSS' });
  if (loss && source.units.measure === 'COUNT' && !loss.isInteger()) throw new DomainError('INVALID_CONVERSION', { reason: 'LOSS' });

  let sourcePacks = input.sourcePacks ?? null;
  let targetPacks = input.targetPacks ?? null;
  if (sourcePacks === null && targetPacks !== null && loss) {
    const packs = targetSize.times(targetPacks).plus(loss).dividedBy(sourceSize);
    if (!packs.isInteger()) throw new DomainError('CONVERSION_UNBALANCED', { reason: 'SOURCE_NOT_WHOLE_PACKS' });
    sourcePacks = packs.toNumber();
  }
  if (targetPacks === null && sourcePacks !== null && loss) {
    const packs = sourceSize.times(sourcePacks).minus(loss).dividedBy(targetSize);
    if (!packs.isInteger()) throw new DomainError('CONVERSION_UNBALANCED', { reason: 'TARGET_NOT_WHOLE_PACKS' });
    targetPacks = packs.toNumber();
  }
  if (sourcePacks === null || targetPacks === null) throw new DomainError('INVALID_CONVERSION', { reason: 'TWO_OF_THREE' });

  // STK-015: the packs moved are whole on both sides; only the loss may be a part-pack.
  const sourceQuantity = toBaseUnits(packCount(sourcePacks), source.units);
  const targetQuantity = toBaseUnits(packCount(targetPacks), target.units);
  if (sourcePacks === 0 || targetPacks === 0) throw new DomainError('INVALID_PACK_COUNT', { value: 0 });
  const derivedLoss = dec(sourceQuantity).minus(dec(targetQuantity));
  if (derivedLoss.isNegative()) throw new DomainError('CONVERSION_UNBALANCED', { reason: 'TARGET_EXCEEDS_SOURCE' });
  if (loss && !loss.eq(derivedLoss)) throw new DomainError('CONVERSION_UNBALANCED', { reason: 'DOES_NOT_BALANCE', expectedLoss: derivedLoss.toString() });
  return { sourcePacks, targetPacks, sourceQuantity, targetQuantity, loss: toQuantity(derivedLoss.isZero() ? new Dec(0) : derivedLoss) };
}
