import type { inventory } from '@gsa/services';

export type ConversionRecord = inventory.ConversionRecord;
export type WriteOff = inventory.WriteOff;
export type ExpiryFlag = inventory.ExpiryFlag;
export type WarehouseCan = { convert: boolean; writeOff: boolean; price: boolean };
export const REASONS = ['DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'OTHER'] as const;
