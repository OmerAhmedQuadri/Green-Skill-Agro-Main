import { DomainError, type BranchId, type PermissionCode, type Role, type UserId } from '@gsa/core';
import type { Tx } from './platform/transaction';

/**
 * Built once per request or job (ARCHITECTURE §6.1). Every use case receives
 * it; nothing reads the clock, the session or the locale any other way.
 * `tx` is set when the caller already holds a transaction (idempotent requests).
 */
export type Ctx = {
  readonly user: { readonly id: UserId; readonly role: Role };
  readonly permissions: ReadonlySet<PermissionCode>;
  readonly now: Date;
  readonly requestId: string;
  readonly locale: 'en' | 'ar';
  readonly branchId: BranchId;
  readonly ip: string | null;
  readonly tx?: Tx;
};

/** First line of every use case (ADR-0005). The interface only hides; this decides. */
export function authorize(ctx: Ctx, permission: PermissionCode): void {
  if (!ctx.permissions.has(permission)) {
    throw new DomainError('FORBIDDEN', { permission });
  }
}

/** For reads several permissions justify — e.g. the catalogue, needed to view it and to price it. */
export function authorizeAny(ctx: Ctx, permissions: readonly PermissionCode[]): void {
  if (!permissions.some((p) => ctx.permissions.has(p))) {
    throw new DomainError('FORBIDDEN', { permission: permissions[0] });
  }
}

/** An update's input: any field may be omitted or explicitly undefined (exactOptionalPropertyTypes). */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
