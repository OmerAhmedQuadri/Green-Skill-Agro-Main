import { z } from 'zod';
import { OptionalText, Version } from './shared';

const Odometer = z.number().int().min(0).max(9_999_999);
const Packs = z.number().int().min(1).max(1_000_000);
const Lines = z.array(z.object({ batchId: z.uuid(), packs: Packs })).min(1).max(200);

/** VEH-001 */
export const CreateVehicleRequest = z.object({
  registration: z.string().trim().min(2).max(20), description: OptionalText(200), odometer: Odometer,
});
export const UpdateVehicleRequest = z.object({
  version: Version, registration: z.string().trim().min(2).max(20).optional(), description: OptionalText(200),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'RETIRED']).optional(),
  odometer: Odometer.optional(), odometerNote: z.string().trim().max(300).optional(),
});

/** VEH-002, 009, 010 */
export const AssignVehicleRequest = z.object({ sellerId: z.uuid() });
export const UnassignVehicleRequest = z.object({ note: OptionalText(300) });
export const CancelRequest = z.object({ version: Version, reason: z.string().trim().min(1).max(500) });

/** VEH-005: the SKUs and quantities to propose batches for. */
export const LoadProposalRequest = z.object({ lines: z.array(z.object({ skuId: z.uuid(), packs: Packs })).min(1).max(100) });
/** VEH-005, 006 */
export const IssueLoadRequest = z.object({ vehicleId: z.uuid(), lines: Lines, acknowledgeCeiling: z.boolean().optional() });
export const AmendLoadRequest = z.object({ version: Version, lines: Lines, acknowledgeCeiling: z.boolean().optional() });
/** VEH-007 */
export const ConfirmLoadRequest = z.object({ version: Version });
export const DisputeLoadRequest = z.object({
  version: Version, comment: z.string().trim().min(1).max(500),
  lines: z.array(z.object({ batchId: z.uuid(), note: z.string().trim().max(300) })).max(200).optional(),
});
export const ListLoadsQuery = z.object({
  status: z.enum(['ISSUED', 'CONFIRMED', 'DISPUTED', 'CANCELLED']).optional(), vehicleId: z.uuid().optional(),
  open: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** STK-012 */
export const VehicleReturnRequest = z.object({
  vehicleId: z.uuid(),
  reason: z.enum(['EXPIRY_RECALL', 'REDISTRIBUTION', 'SELLER_LEAVING', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL']),
  note: OptionalText(500), lines: Lines,
});

/** STK-010, 011 */
export const DeclareClosingStockRequest = z.object({
  lines: z.array(z.object({ skuId: z.uuid(), packs: z.number().int().min(0).max(1_000_000) })).max(500),
});
export const ReviewClosingStockRequest = z.object({ version: Version, comment: z.string().trim().min(1).max(500) });
export const ListClosingStockQuery = z.object({
  status: z.enum(['MATCHED', 'VARIANCE_FLAGGED', 'REVIEWED']).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
});

/** VEH-011..013, ADR-0041: the physical count of a vehicle's stock. */
export const OpenAuditRequest = z.object({ vehicleId: z.uuid(), note: OptionalText(500) });
export const RecordCountRequest = z.object({
  version: Version,
  lines: z.array(z.object({ batchId: z.uuid(), packs: z.number().int().min(0).max(1_000_000), comment: OptionalText(500) })).min(1).max(500),
});
export const CloseAuditRequest = z.object({ version: Version, note: OptionalText(500) });
/** OQ-022 */
export const DecideSurplusRequest = z.object({ lineId: z.uuid(), approve: z.boolean(), comment: OptionalText(500) });
export const ListAuditsQuery = z.object({ vehicleId: z.uuid().optional(), status: z.enum(['IN_PROGRESS', 'CLOSED']).optional() });
