import { z } from 'zod';
import { Limit, OptionalText, QueryBoolean, Version } from './shared';

/** VEN-001: the seven fields. Code, name and country are required. */
const Fields = {
  name: z.string().trim().min(1).max(200),
  country: z.string().trim().length(2),
  address: OptionalText(500),
  contactPerson: OptionalText(200),
  phone: OptionalText(32),
  email: OptionalText(254),
};

export const CreateVendorRequest = z.object({ code: z.string().trim().min(1).max(20), ...Fields });
/** The code is not editable: products name the vendor by it (VEN-004). */
export const UpdateVendorRequest = z.object({ version: Version, ...z.object(Fields).partial().shape, isActive: z.boolean().optional() });

export const ListVendorsQuery = z.object({
  search: z.string().trim().max(100).optional(), isActive: QueryBoolean.optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});
