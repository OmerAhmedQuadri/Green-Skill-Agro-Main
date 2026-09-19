import { z } from 'zod';
import { Limit, MoneyString, OptionalText, Version } from './shared';

/** CSH-002, CSH-003: a bank deposit needs its date; a handover needs the manager who took it. */
export const SubmitSettlementRequest = z.object({
  route: z.enum(['BANK_DEPOSIT', 'MANAGER_HANDOVER']),
  amount: MoneyString,
  photoId: z.uuid(),
  depositedOn: z.iso.date().nullable().optional(),
  receivedById: z.uuid().nullable().optional(),
  note: OptionalText(500),
});

/** CSH-004, CSH-006: approve — for the declared amount unless the manager counted otherwise — or reject, with a comment. */
export const DecideSettlementRequest = z.object({
  version: Version, approve: z.boolean(), amount: MoneyString.nullable().optional(), comment: OptionalText(500),
});

export const ListSettlementsQuery = z.object({
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(), sellerId: z.uuid().optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});
