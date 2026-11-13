import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** COR-006: correct an imported sale's lines and total, in the caller's open correction session. */
export const POST = mutation<typeof contract.ImportedSaleCorrectionRequest, { id: string }>(
  contract.ImportedSaleCorrectionRequest,
  async ({ ctx, input, params }) => ({ status: 201, body: await corrections.correctImportedSale(ctx, params.id, input) }),
);
