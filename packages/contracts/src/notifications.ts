import { z } from 'zod';

export const ListNotificationsQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
/** No ids: mark every notification read. */
export const MarkReadRequest = z.object({ ids: z.array(z.uuid()).max(100).optional() });
