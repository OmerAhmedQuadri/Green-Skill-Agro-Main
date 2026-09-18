import { DomainError } from '../errors';
import { dec, money, type Money, type Percent } from '../numeric';

/** PRC-001: a price is per pack of one SKU, in SAR, and never zero. */
export function price(value: string): Money {
  const amount = money(value);
  if (!dec(amount).gt(0)) throw new DomainError('INVALID_PRICE', { value });
  return amount;
}

/**
 * PRC-006: where the order ceiling and the item's own ceiling both apply, the
 * tighter governs. An item capped at 5% cannot take 10% because the order
 * ceiling would allow it.
 */
export function applicableItemCeiling(orderCeiling: Percent, itemCeiling: Percent): Percent {
  return dec(itemCeiling).lt(dec(orderCeiling)) ? itemCeiling : orderCeiling;
}

/**
 * PRC-016: above the absolute maximum no approval can be requested, so a
 * ceiling above it would be a ceiling nothing could ever reach.
 */
export function assertWithinMaximum(ceiling: Percent, absoluteMaximum: Percent, field: string): void {
  if (dec(ceiling).gt(dec(absoluteMaximum))) {
    throw new DomainError('CEILING_ABOVE_MAXIMUM', { field, ceiling, absoluteMaximum });
  }
}
