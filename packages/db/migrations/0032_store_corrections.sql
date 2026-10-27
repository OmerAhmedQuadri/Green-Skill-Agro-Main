-- M13: store-account corrections (COR-002, COR-005, ADR-0059 amended 10-27). A correction reverses the entry it
-- corrects and posts the corrected one; nothing already written is changed.
-- APPEND-ONLY: store_corrections (UPDATE and DELETE revoked below).
-- payments gain correction_id (a payment a correction recorded) and superseded_by (the correction that replaced or
-- removed it). superseded_by is the one column of a payment the app may set, once (trigger below); voucher numbers
-- and imported payments stay unique among the payments that stand.
-- cash_ledger_entries take a CORRECTION, either way, for a collector's cash in hand the Super Admin chose to correct.
CREATE TYPE "public"."store_correction_kind" AS ENUM('BILL', 'PAYMENT');--> statement-breakpoint
ALTER TYPE "public"."cash_ledger_entry_type" ADD VALUE 'CORRECTION';--> statement-breakpoint
CREATE TABLE "store_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "store_corrections_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" uuid NOT NULL,
	"kind" "store_correction_kind" NOT NULL,
	"store_id" uuid NOT NULL,
	"to_store_id" uuid,
	"original_entry_id" uuid NOT NULL,
	"original_payment_id" uuid,
	"before" jsonb NOT NULL,
	"after" jsonb,
	"reason" text NOT NULL,
	"cash_in_hand" boolean DEFAULT false NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "store_corrections_reason" CHECK (length(btrim("store_corrections"."reason")) > 0),
	CONSTRAINT "store_corrections_payment" CHECK (("store_corrections"."kind" = 'PAYMENT') = ("store_corrections"."original_payment_id" is not null)),
	CONSTRAINT "store_corrections_moved" CHECK ("store_corrections"."to_store_id" is null or ("store_corrections"."after" is not null and "store_corrections"."to_store_id" <> "store_corrections"."store_id")),
	CONSTRAINT "store_corrections_cash" CHECK (not "store_corrections"."cash_in_hand" or "store_corrections"."kind" = 'PAYMENT')
);
--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" DROP CONSTRAINT "cash_ledger_sign";--> statement-breakpoint
DROP INDEX "payments_imported_payment_unique";--> statement-breakpoint
DROP INDEX "payments_voucher_number_unique";--> statement-breakpoint
DROP INDEX "store_ledger_entries_imported_once";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_session_id_correction_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."correction_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_to_store_id_stores_id_fk" FOREIGN KEY ("to_store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_original_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("original_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_original_payment_id_payments_id_fk" FOREIGN KEY ("original_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_corrections_number_unique" ON "store_corrections" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "store_corrections_original_entry_unique" ON "store_corrections" USING btree ("original_entry_id");--> statement-breakpoint
CREATE INDEX "store_corrections_session_id_idx" ON "store_corrections" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "store_corrections_store_id_idx" ON "store_corrections" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "store_corrections_to_store_id_idx" ON "store_corrections" USING btree ("to_store_id");--> statement-breakpoint
CREATE INDEX "store_corrections_original_payment_id_idx" ON "store_corrections" USING btree ("original_payment_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_correction_id_store_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."store_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_superseded_by_store_corrections_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."store_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_correction_id_idx" ON "payments" USING btree ("correction_id");--> statement-breakpoint
CREATE INDEX "payments_superseded_by_idx" ON "payments" USING btree ("superseded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_imported_payment_unique" ON "payments" USING btree ("imported_payment_id") WHERE "payments"."imported_payment_id" is not null and "payments"."superseded_by" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_voucher_number_unique" ON "payments" USING btree ("voucher_number") WHERE "payments"."voucher_number" is not null and "payments"."superseded_by" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "store_ledger_entries_imported_once" ON "store_ledger_entries" USING btree ("reference_type","reference_id") WHERE "store_ledger_entries"."origin" = 'IMPORT' and "store_ledger_entries"."reference_type" = 'IMPORTED_SALE';--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_sign" CHECK (("cash_ledger_entries"."entry_type" = 'COLLECTION' and "cash_ledger_entries"."amount" > 0) or ("cash_ledger_entries"."entry_type" in ('SETTLEMENT_APPROVED', 'REFUND') and "cash_ledger_entries"."amount" < 0) or ("cash_ledger_entries"."entry_type" not in ('COLLECTION', 'SETTLEMENT_APPROVED', 'REFUND') and "cash_ledger_entries"."amount" <> 0));--> statement-breakpoint
CREATE FUNCTION payments_superseded_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION 'payment % is replaced once, and never put back', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_superseded_once';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_superseded_once BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_superseded_once();
--> statement-breakpoint
GRANT UPDATE ("superseded_by") ON "payments" TO gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "store_corrections" FROM gsa_app;
