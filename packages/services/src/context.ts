import { DomainError, type BranchId, type PermissionCode, type Role, type UserId } from '@gsa/core';

/**
 * Built once per request or job (ARCHITECTURE §6.1). Every use case receives
 * it; nothing reads the clock, the session or the locale any other way.
 */
export type Ctx = {
  readonly user: { readonly id: UserId; readonly role: Role };
  readonly permissions: ReadonlySet<PermissionCode>;
  readonly now: Date;
  readonly requestId: string;
  readonly locale: 'en' | 'ar';
  readonly branchId: BranchId;
};

/** First line of every use case (ADR-0005). The interface only hides; this decides. */
export function authorize(ctx: Ctx, permission: PermissionCode): void {
  if (!ctx.permissions.has(permission)) {
    throw new DomainError('FORBIDDEN', { permission });
  }
}
