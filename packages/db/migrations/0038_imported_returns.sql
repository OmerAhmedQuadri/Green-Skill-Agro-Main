-- IMP-011 (ADR-0059, amended 2026-11-13): Green Agro's final books list sales returns, and they are imported. Each is
-- recorded as written, naming its invoice where the book does, and goes into the store's account at re-verification
-- as a credit referencing IMPORTED_RETURN — once (the posted-once index now covers returns too). No stock moves.
-- APPEND-ONLY: imported_returns, imported_return_lines (UPDATE and DELETE revoked below).
CREATE TABLE "imported_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"imported_return_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_written" text NOT NULL,
	"pack_written" text,
	"sku_id" uuid,
	"packs" numeric(12, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_return_lines_figures" CHECK ("imported_return_lines"."line_no" > 0 and "imported_return_lines"."packs" > 0 and "imported_return_lines"."unit_price" >= 0 and "imported_return_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "imported_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"returned_on" date NOT NULL,
	"number" text NOT NULL,
	"imported_sale_id" uuid,
	"book" text NOT NULL,
	"book_row" integer NOT NULL,
	"store_name_written" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "imported_returns_amount" CHECK ("imported_returns"."amount" > 0),
	CONSTRAINT "imported_returns_where" CHECK ("imported_returns"."book_row" > 0)
);
--> statement-breakpoint
DROP INDEX "store_ledger_entries_imported_once";--> statement-breakpoint
ALTER TABLE "imported_return_lines" ADD CONSTRAINT "imported_return_lines_imported_return_id_imported_returns_id_fk" FOREIGN KEY ("imported_return_id") REFERENCES "public"."imported_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_return_lines" ADD CONSTRAINT "imported_return_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_imported_sale_id_imported_sales_id_fk" FOREIGN KEY ("imported_sale_id") REFERENCES "public"."imported_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_returns" ADD CONSTRAINT "imported_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imported_return_lines_line_unique" ON "imported_return_lines" USING btree ("imported_return_id","line_no");--> statement-breakpoint
CREATE INDEX "imported_return_lines_sku_id_idx" ON "imported_return_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_returns_number_unique" ON "imported_returns" USING btree ("batch_id","seller_id","number");--> statement-breakpoint
CREATE INDEX "imported_returns_store_id_idx" ON "imported_returns" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "imported_returns_seller_id_idx" ON "imported_returns" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "imported_returns_imported_sale_id_idx" ON "imported_returns" USING btree ("imported_sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_ledger_entries_imported_once" ON "store_ledger_entries" USING btree ("reference_type","reference_id") WHERE "store_ledger_entries"."origin" = 'IMPORT' and "store_ledger_entries"."reference_type" in ('IMPORTED_SALE', 'IMPORTED_RETURN');--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_returns" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_return_lines" FROM gsa_app;
