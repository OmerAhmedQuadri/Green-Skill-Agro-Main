import { DomainError } from '@gsa/core';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'SELLER';

/**
 * Built once per request or job (ARCHITECTURE §6.1). Every use case receives
 * it; nothing reads the clock, the session or the locale any other way.
 */
export type Ctx = {
  readonly user: { readonly id: string; readonly role: Role };
  readonly permissions: ReadonlySet<string>;
  readonly now: Date;
  readonly requestId: string;
  readonly locale: 'en' | 'ar';
  readonly branchId: string;
};

/** First line of every use case (ADR-0005). The interface only hides; this decides. */
export function authorize(ctx: Ctx, permission: string): void {
  if (!ctx.permissions.has(permission)) {
    throw new DomainError('FORBIDDEN', { permission });
  }
}
