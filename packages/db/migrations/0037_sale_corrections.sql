-- M13 step e: sale corrections (COR-006, ADR-0059 amended 10-28). A sale made in the app keeps its corrected figures;
-- the correction keeps what it was. Its stock, delivery document, bill and cash follow only as the Super Admin chose,
-- each reversed and posted again, never overwritten. An imported sale's correction writes the corrected invoice.
-- APPEND-ONLY: sale_corrections, sale_correction_allocations (UPDATE and DELETE revoked below).
-- sales may be REMOVED by a correction: the checks name only the statuses that existed before, as the new value
-- cannot be used in the transaction that adds it.
-- delivery_documents gain a version: a corrected copy keeps its number.
-- imported_sales gain correction_id and replaced_by; replaced_by is the one column the app may set, once (trigger).
-- store_corrections gain sale_id: the bill of an app sale, corrected through the sale.
ALTER TYPE "public"."stock_reference_type" ADD VALUE 'SALE_CORRECTION';--> statement-breakpoint
ALTER TYPE "public"."sale_status" ADD VALUE 'REMOVED';--> statement-breakpoint
CREATE TABLE "sale_correction_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"correction_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "sale_correction_allocations_quantity" CHECK ("sale_correction_allocations"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "sale_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "sale_corrections_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" uuid NOT NULL,
	"sale_id" uuid,
	"imported_sale_id" uuid,
	"before" jsonb NOT NULL,
	"after" jsonb,
	"reason" text NOT NULL,
	"stock" boolean DEFAULT false NOT NULL,
	"document" boolean DEFAULT false NOT NULL,
	"account" boolean DEFAULT false NOT NULL,
	"cash_in_hand" boolean DEFAULT false NOT NULL,
	"store_correction_id" uuid,
	"document_id" uuid,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "sale_corrections_reason" CHECK (length(btrim("sale_corrections"."reason")) > 0),
	CONSTRAINT "sale_corrections_one_sale" CHECK (("sale_corrections"."sale_id" is null) <> ("sale_corrections"."imported_sale_id" is null)),
	CONSTRAINT "sale_corrections_imported" CHECK ("sale_corrections"."imported_sale_id" is null
      or ("sale_corrections"."after" is not null and not "sale_corrections"."stock" and not "sale_corrections"."document" and not "sale_corrections"."cash_in_hand")),
	CONSTRAINT "sale_corrections_account" CHECK ("sale_corrections"."account" = ("sale_corrections"."store_correction_id" is not null)),
	CONSTRAINT "sale_corrections_document" CHECK ("sale_corrections"."document" = ("sale_corrections"."document_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "delivery_documents" DROP CONSTRAINT "delivery_documents_sale_id_unique";--> statement-breakpoint
ALTER TABLE "delivery_documents" DROP CONSTRAINT "delivery_documents_number_unique";--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_completed";--> statement-breakpoint
DROP INDEX "imported_sales_serial_unique";--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_correction_allocations" ADD CONSTRAINT "sale_correction_allocations_correction_id_sale_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."sale_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_correction_allocations" ADD CONSTRAINT "sale_correction_allocations_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_correction_allocations" ADD CONSTRAINT "sale_correction_allocations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_session_id_correction_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."correction_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_imported_sale_id_imported_sales_id_fk" FOREIGN KEY ("imported_sale_id") REFERENCES "public"."imported_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_store_correction_id_store_corrections_id_fk" FOREIGN KEY ("store_correction_id") REFERENCES "public"."store_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_document_id_delivery_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."delivery_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_correction_allocations_unique" ON "sale_correction_allocations" USING btree ("correction_id","sale_line_id","batch_id");--> statement-breakpoint
CREATE INDEX "sale_correction_allocations_sale_line_id_idx" ON "sale_correction_allocations" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "sale_correction_allocations_batch_id_idx" ON "sale_correction_allocations" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_corrections_number_unique" ON "sale_corrections" USING btree ("number");--> statement-breakpoint
CREATE INDEX "sale_corrections_session_id_idx" ON "sale_corrections" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sale_corrections_sale_id_idx" ON "sale_corrections" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_corrections_imported_sale_id_idx" ON "sale_corrections" USING btree ("imported_sale_id");--> statement-breakpoint
CREATE INDEX "sale_corrections_store_correction_id_idx" ON "sale_corrections" USING btree ("store_correction_id");--> statement-breakpoint
CREATE INDEX "sale_corrections_document_id_idx" ON "sale_corrections" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_correction_id_sale_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."sale_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_replaced_by_sale_corrections_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."sale_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_documents_sale_version_unique" ON "delivery_documents" USING btree ("sale_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_documents_number_version_unique" ON "delivery_documents" USING btree ("number","version");--> statement-breakpoint
CREATE INDEX "imported_sales_correction_id_idx" ON "imported_sales" USING btree ("correction_id");--> statement-breakpoint
CREATE INDEX "imported_sales_replaced_by_idx" ON "imported_sales" USING btree ("replaced_by");--> statement-breakpoint
CREATE INDEX "store_corrections_sale_id_idx" ON "store_corrections" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_sales_serial_unique" ON "imported_sales" USING btree ("batch_id","seller_id","serial") WHERE "imported_sales"."replaced_by" is null;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_version" CHECK ("delivery_documents"."version" >= 1);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_completed" CHECK (("sales"."status" not in ('PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'CANCELLED'))
      = ("sales"."completed_at" is not null and ("sales"."ledger_entry_id" is not null or ("sales"."store_id" is null and "sales"."payment_id" is not null))));--> statement-breakpoint
ALTER TABLE "store_corrections" ADD CONSTRAINT "store_corrections_sale" CHECK ("store_corrections"."sale_id" is null or "store_corrections"."kind" = 'BILL');--> statement-breakpoint
CREATE FUNCTION imported_sales_replaced_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.replaced_by IS NOT NULL OR NEW.replaced_by IS NULL THEN
    RAISE EXCEPTION 'imported sale % is replaced once, and never put back', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'imported_sales_replaced_once';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER imported_sales_replaced_once BEFORE UPDATE ON imported_sales FOR EACH ROW EXECUTE FUNCTION imported_sales_replaced_once();
--> statement-breakpoint
GRANT UPDATE ("replaced_by") ON "imported_sales" TO gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "sale_corrections" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "sale_correction_allocations" FROM gsa_app;
