import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@gsa/core';
import { identity, runIdempotent, type Ctx, type Outcome } from '@gsa/services';
import { cookies, headers } from 'next/headers';
import type { z } from 'zod';
import { toProblem } from './errors';
import { SESSION_COOKIE } from './session-cookie';

export type RequestMeta = { requestId: string; ip: string | null; userAgent: string | null; now: Date };

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return {
    requestId: h.get('x-request-id') ?? randomUUID(),
    // The client address comes only from X-Real-IP, which nginx overwrites with
    // $remote_addr. X-Forwarded-For is never trusted: its first entry is
    // whatever the client sent, so it could dodge per-IP rate limits (SECURITY §2).
    ip: h.get('x-real-ip')?.trim() || null,
    userAgent: h.get('user-agent'),
    now: new Date(),
  };
}

type Params = Record<string, string>;
type Handler<P extends Params> = (args: { request: Request; meta: RequestMeta; params: P }) => Promise<Response>;

/** Public routes (sign-in, health): error mapping only. */
export function publicRoute<P extends Params = Params>(handler: Handler<P>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const meta = await requestMeta();
    try {
      return await handler({ request, meta, params: await context.params });
    } catch (error) {
      return toProblem(error, meta.requestId);
    }
  };
}

type AuthedArgs<P extends Params> = { request: Request; meta: RequestMeta; params: P; ctx: Ctx; token: string };

/**
 * Authenticated routes (ARCHITECTURE §5). Resolves the session into a Ctx; a
 * user who must change their password can reach nothing else until they do.
 * Authorisation itself happens in the service (ADR-0005).
 */
export function authedRoute<P extends Params = Params>(
  handler: (args: AuthedArgs<P>) => Promise<Response>,
  opts: { allowPendingPasswordChange?: boolean } = {},
) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const meta = await requestMeta();
    try {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      const session = token ? await identity.resolveSession(token, meta) : null;
      if (!session || !token) throw new DomainError('UNAUTHENTICATED');
      if (session.mustChangePassword && !opts.allowPendingPasswordChange) throw new DomainError('PASSWORD_CHANGE_REQUIRED');
      return await handler({ request, meta, params: await context.params, ctx: session.ctx, token });
    } catch (error) {
      return toProblem(error, meta.requestId);
    }
  };
}

/**
 * Mutations run exactly once per Idempotency-Key (ADR-0009, CONVENTIONS §5).
 * The same key with a different body is refused.
 */
export function mutation<S extends z.ZodType, P extends Params = Params, R = unknown>(
  schema: S,
  work: (args: AuthedArgs<P> & { input: z.infer<S> }) => Promise<Outcome<R>>,
) {
  return authedRoute<P>(async (args) => {
    const key = args.request.headers.get('idempotency-key');
    if (!key || key.length > 200) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED');
    }
    const raw = await args.request.text();
    const input: z.infer<S> = schema.parse(raw ? JSON.parse(raw) : {});
    const hash = createHash('sha256').update(`${args.request.method} ${new URL(args.request.url).pathname}\n${raw}`).digest('hex');
    const outcome = await runIdempotent(args.ctx, { key, hash }, (ctx) => work({ ...args, ctx, input }));
    return Response.json(outcome.body, { status: outcome.status, headers: outcome.replayed ? { 'idempotent-replayed': 'true' } : {} });
  });
}
