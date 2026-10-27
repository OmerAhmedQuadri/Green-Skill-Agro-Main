import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** IMP-009: a warning kept as it is, or marked corrected in the caller's open session — once, with a note. */
export const POST = mutation<typeof contract.ResolveImportWarningRequest, { id: string }>(contract.ResolveImportWarningRequest, async ({ ctx, params, input }) => {
  await corrections.resolveImportWarning(ctx, params.id, input);
  return { status: 200, body: { ok: true } };
});
