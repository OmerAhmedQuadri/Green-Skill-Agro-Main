import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { cookies } from 'next/headers';
import { authedRoute, mutation } from '@/server/route';

/** USR-008: the effective permission set the interface renders from. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await identity.getMe(ctx)), {
  allowPendingPasswordChange: true,
});

export const PATCH = mutation(contract.UpdateMeRequest, async ({ ctx, input }) => {
  await identity.updateMyPreferences(ctx, input);
  (await cookies()).set({ name: 'NEXT_LOCALE', value: input.locale, path: '/', sameSite: 'lax', maxAge: 31_536_000 });
  return { status: 200, body: { locale: input.locale } };
});
