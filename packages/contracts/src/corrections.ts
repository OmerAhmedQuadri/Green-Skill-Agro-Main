import { z } from 'zod';
import { Limit, OptionalText, Version } from './shared';

/** COR-001: the Super Admin's own password again, and why the session is opened. A blank reason is the service's to refuse. */
export const OpenCorrectionSessionRequest = z.object({ password: z.string().min(1).max(256), reason: z.string().max(1000) });

/** COR-003: keep the reason, add to it, or edit it; adding and editing carry the words. */
export const CloseCorrectionSessionRequest = z.object({
  version: Version, closing: z.enum(['KEPT', 'ADDED', 'EDITED']), text: OptionalText(1000),
});

export const ListCorrectionSessionsQuery = z.object({ cursor: z.string().max(20).optional(), limit: Limit.optional() });
