import { z } from 'zod';

/** NFR-004: from the browser's geolocation, at check-in and check-out only (ATT-013). */
export const Location = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional(),
});

/** ATT-001, ATT-007: odometer photo and reading only with a vehicle. */
const Capture = z.object({
  location: Location, selfieId: z.uuid(),
  odometer: z.number().int().min(0).max(9_999_999).nullable().optional(), odometerPhotoId: z.uuid().nullable().optional(),
});
export const CheckInRequest = Capture.extend({ withoutVehicle: z.boolean().optional() });
export const CheckOutRequest = Capture;

/** ATT-011 */
export const OpenDayRequest = z.object({
  sellerId: z.uuid(), reason: z.string().trim().min(1).max(500), odometer: z.number().int().min(0).max(9_999_999).nullable().optional(),
});
/** ATT-012 */
export const ReviewSessionRequest = z.object({ comment: z.string().trim().min(1).max(500) });

export const ListAttendanceQuery = z.object({
  from: z.iso.date().optional(), to: z.iso.date().optional(), sellerId: z.uuid().optional(),
  attention: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** ATT-008 */
export const ZoneRequest = z.object({
  name: z.string().trim().min(1).max(120), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(25).max(50_000), isActive: z.boolean().optional(),
});
export const UpdateZoneRequest = ZoneRequest.partial().extend({ version: z.number().int().min(1) });
