import { z } from 'zod';

/**
 * IMP-001..004, IMP-009 (ADR-0059): the history import file — Green Agro's sellers' books, read and joined by our
 * tools (docs/reference/client-data/tools), in one checked shape the app loads (`pnpm db:import-history`). It holds
 * client data: it is never committed.
 *
 * Stores, sellers and the lines' products are named here as the books name them; the app resolves sellers through
 * `--seller Name=email` and products against its own catalogue, so one file loads on staging and on production.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Amount = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/);
const Packs = z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/);
const Written = { book: Text(200), bookRow: z.number().int().min(1), storeNameWritten: Text(300) };

const File = z.object({ name: Text(300), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(1) });

const Product = z.object({
  name: Text(200), variety: z.string().trim().max(200).nullable().optional(),
  /** The pack in grams, as the stock list gives it; a pack that is not a weight is matched by name alone. */
  packGrams: z.number().positive().nullable().optional(),
});

const Line = z.object({
  item: Text(300), pack: z.string().trim().max(100).nullable().optional(),
  /** The catalogue product the line names, where our tools found one. */
  product: Product.nullable().optional(),
  packs: Packs, unitPrice: Amount, amount: Amount,
});

const Sale = z.object({
  store: Text(100), seller: Text(100), soldOn: Day, serial: z.number().int().min(1), discount: Amount.optional(),
  lines: z.array(Line).min(1).max(200), ...Written,
});

const Payment = z.object({
  /** Null for a payment nobody could place: it waits for the Super Admin (IMP-009). */
  store: Text(100).nullable(), seller: Text(100), paidOn: Day, amount: Amount,
  kind: z.enum(['VOUCHER', 'PAID_AT_SALE']), method: z.enum(['CASH', 'BANK_TRANSFER']),
  voucherNumber: z.string().trim().max(60).nullable().optional(), invoiceSerial: z.number().int().min(1).nullable().optional(),
  ...Written,
});

/** A record a warning is about: a store by its key, or a sale or payment by its book and row. */
const Subject = z.object({ book: Text(200), bookRow: z.number().int().min(1) });

const Warning = z.object({
  kind: z.enum([
    'VOUCHER_MISSING', 'VOUCHER_NOT_IN_BOOKS', 'NAME_JOINED_BY_GUESS', 'PAYMENT_NO_STORE', 'PAYMENT_HELD_BACK', 'NAMES_MAY_BE_ONE_STORE',
    'LINE_DOES_NOT_ADD_UP', 'LINE_NOT_IN_CATALOGUE', 'LINE_READ_AS_OTHER_PACK', 'DATE_DIFFERS_FROM_STATEMENT', 'RETURN_NOT_IMPORTED',
    'BALANCE_DIFFERS_FROM_STATEMENT',
  ]),
  store: Text(100).optional(), sale: Subject.optional(), payment: Subject.optional(),
  params: z.record(z.string(), z.union([z.string().max(300), z.number()])).default({}),
}).refine((w) => [w.store, w.sale, w.payment].filter(Boolean).length === 1, { message: 'a warning is about one store, sale or payment' });

export const HistoryImportFile = z.object({
  format: z.literal('gsa-history/1'),
  /** The books it was read from, as they were. */
  files: z.array(File).min(1).max(50),
  note: z.string().trim().max(1000).optional(),
  /** Each store by a key the file's sales, payments and warnings use, its name, and its seller as the books name them. */
  stores: z.array(z.object({ key: Text(100), name: Text(300), seller: Text(100) })).max(5000),
  sales: z.array(Sale).max(50_000),
  payments: z.array(Payment).max(50_000),
  warnings: z.array(Warning).max(20_000),
});
export type HistoryImportFile = z.infer<typeof HistoryImportFile>;
