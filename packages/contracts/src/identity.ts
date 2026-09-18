import { z } from 'zod';

/**
 * Identity API contracts (API.md — Identity and users). The same schemas
 * validate on the server and resolve client forms (CONVENTIONS §7).
 */
export const Role = z.enum(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SELLER']);
export const Locale = z.enum(['en', 'ar']);
export const AccountStatus = z.enum(['ACTIVE', 'DEACTIVATED']);
/** Shape only; the service checks the code exists in the catalogue. */
export const PermissionCode = z.string().regex(/^[a-z]+\.[a-z_]+$/);

export const SignInRequest = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});

export const SignedInUser = z.object({
  id: z.uuid(), role: Role, locale: Locale, mustChangePassword: z.boolean(),
});

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(256),
});

export const ForgotPasswordRequest = z.object({ email: z.string().trim().min(3).max(254) });

export const ResetPasswordRequest = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(10).max(256),
});

export const Me = z.object({
  id: z.uuid(), role: Role, name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  locale: Locale, mustChangePassword: z.boolean(), permissions: z.array(z.string()),
});

export const UpdateMeRequest = z.object({ locale: Locale });

export const AccountSummary = z.object({
  id: z.uuid(), role: Role, name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  status: AccountStatus, locale: Locale, mustChangePassword: z.boolean(), version: z.number().int(),
});

export const AccountDetail = AccountSummary.extend({
  permissions: z.array(z.string()),
  overrides: z.array(z.object({ permission: z.string(), granted: z.boolean() })),
  configurable: z.array(z.string()),
});

export const ListAccountsQuery = z.object({
  role: Role.optional(),
  status: AccountStatus.optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const optionalText = z.string().trim().max(254).optional().transform((v) => (v ? v : undefined));

export const CreateAccountRequest = z
  .object({ role: Role, name: z.string().trim().min(1).max(120), email: optionalText, phone: optionalText, locale: Locale.optional() })
  .refine((v) => v.email || v.phone, { message: 'EMAIL_OR_PHONE_REQUIRED', path: ['email'] });

export const CreateAccountResponse = z.object({
  account: AccountDetail,
  /** Shown once. A replayed request returns null — reset the password to issue another. */
  temporaryPassword: z.string().nullable(),
});

export const UpdateAccountRequest = z.object({
  version: z.number().int(),
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  locale: Locale.optional(),
});

export const VersionedRequest = z.object({ version: z.number().int() });

export const ResetPasswordResponse = z.object({ temporaryPassword: z.string().nullable() });

export const ChangePermissionsRequest = z.object({
  changes: z.array(z.object({ permission: PermissionCode, granted: z.boolean() })).min(1).max(100),
});

export const ApplyPresetRequest = z.object({ preset: z.string().regex(/^[A-Z_]+$/) });

export const PermissionPreset = z.object({ code: z.string(), permissions: z.array(z.string()) });
