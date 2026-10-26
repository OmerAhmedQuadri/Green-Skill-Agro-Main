-- M13: imported history (IMP-001..006, ADR-0059). What Green Agro's sellers' books say, recorded as written;
-- nothing here is posted to a store account until the seller re-verifies the store (IMP-005).
-- APPEND-ONLY: imported_sales, imported_sale_lines, imported_payments (UPDATE and DELETE revoked below).
-- MUTABLE ENTITY: import_batches (version, updated_*): undone as a whole, its records left in place.
-- store_ledger_entries and payments gain their origin (APP, IMPORT) and import batch; existing rows are APP.
CREATE TYPE "public"."entry_origin" AS ENUM('APP', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."imported_payment_kind" AS ENUM('VOUCHER', 'PAID_AT_SALE');--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('LOADED', 'UNDONE');--> statement-breakpoint
CREATE TABLE "imported_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"store_id" uuid,
	"seller_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"kind" "imported_payment_kind" NOT NULL,
	"method" "payment_method" NOT NULL,
	"voucher_number" text,
	"invoice_serial" integer,
	"book" text NOT NULL,
	"book_row" integer NOT NULL,
	"store_name_written" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "imported_payments_amount_positive" CHECK ("imported_payments"."amount" > 0),
	CONSTRAINT "imported_payments_kind" CHECK (("imported_payments"."kind" = 'PAID_AT_SALE') = ("imported_payments"."invoice_serial" is not null)
      and ("imported_payments"."kind" = 'VOUCHER' or "imported_payments"."voucher_number" is null)),
	CONSTRAINT "imported_payments_book_row" CHECK ("imported_payments"."book_row" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "import_batches_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"status" "import_batch_status" DEFAULT 'LOADED' NOT NULL,
	"files" jsonb NOT NULL,
	"note" text,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_reason" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "import_batches_files" CHECK (jsonb_typeof("import_batches"."files") = 'array' and jsonb_array_length("import_batches"."files") > 0),
	CONSTRAINT "import_batches_undone" CHECK (("import_batches"."status" = 'UNDONE') = ("import_batches"."undone_at" is not null)
      and ("import_batches"."undone_at" is null) = ("import_batches"."undone_by" is null) and ("import_batches"."undone_at" is null) = ("import_batches"."undo_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "imported_sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"imported_sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_written" text NOT NULL,
	"pack_written" text,
	"sku_id" uuid,
	"packs" numeric(12, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_sale_lines_figures" CHECK ("imported_sale_lines"."line_no" > 0 and "imported_sale_lines"."packs" > 0 and "imported_sale_lines"."unit_price" >= 0 and "imported_sale_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "imported_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"sold_on" date NOT NULL,
	"book" text NOT NULL,
	"book_row" integer NOT NULL,
	"serial" integer NOT NULL,
	"store_name_written" text NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "imported_sales_discount" CHECK ("imported_sales"."discount" >= 0),
	CONSTRAINT "imported_sales_total" CHECK ("imported_sales"."total" > 0 and "imported_sales"."total" = "imported_sales"."subtotal" - "imported_sales"."discount"),
	CONSTRAINT "imported_sales_where" CHECK ("imported_sales"."book_row" > 0 and "imported_sales"."serial" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "origin" "entry_origin" DEFAULT 'APP' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "imported_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD COLUMN "origin" "entry_origin" DEFAULT 'APP' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "imported_payments" ADD CONSTRAINT "imported_payments_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payments" ADD CONSTRAINT "imported_payments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payments" ADD CONSTRAINT "imported_payments_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payments" ADD CONSTRAINT "imported_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payments" ADD CONSTRAINT "imported_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sale_lines" ADD CONSTRAINT "imported_sale_lines_imported_sale_id_imported_sales_id_fk" FOREIGN KEY ("imported_sale_id") REFERENCES "public"."imported_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sale_lines" ADD CONSTRAINT "imported_sale_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sales" ADD CONSTRAINT "imported_sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imported_payments_batch_id_idx" ON "imported_payments" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "imported_payments_store_id_idx" ON "imported_payments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "imported_payments_seller_id_idx" ON "imported_payments" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_payments_voucher_unique" ON "imported_payments" USING btree ("batch_id","voucher_number") WHERE "imported_payments"."voucher_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_number_unique" ON "import_batches" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_sale_lines_line_unique" ON "imported_sale_lines" USING btree ("imported_sale_id","line_no");--> statement-breakpoint
CREATE INDEX "imported_sale_lines_sku_id_idx" ON "imported_sale_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_sales_serial_unique" ON "imported_sales" USING btree ("batch_id","seller_id","serial");--> statement-breakpoint
CREATE INDEX "imported_sales_store_id_idx" ON "imported_sales" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "imported_sales_seller_id_idx" ON "imported_sales" USING btree ("seller_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_imported_payment_id_imported_payments_id_fk" FOREIGN KEY ("imported_payment_id") REFERENCES "public"."imported_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD CONSTRAINT "store_ledger_entries_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_import_batch_id_idx" ON "payments" USING btree ("import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_imported_payment_unique" ON "payments" USING btree ("imported_payment_id") WHERE "payments"."imported_payment_id" is not null;--> statement-breakpoint
CREATE INDEX "store_ledger_entries_import_batch_id_idx" ON "store_ledger_entries" USING btree ("import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_ledger_entries_imported_once" ON "store_ledger_entries" USING btree ("reference_type","reference_id") WHERE "store_ledger_entries"."origin" = 'IMPORT';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_import_source" CHECK (("payments"."origin" = 'IMPORT') = ("payments"."import_batch_id" is not null)
      and ("payments"."origin" = 'IMPORT') = ("payments"."imported_payment_id" is not null));--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD CONSTRAINT "store_ledger_import_batch" CHECK (("store_ledger_entries"."origin" = 'IMPORT') = ("store_ledger_entries"."import_batch_id" is not null));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_sales" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_sale_lines" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_payments" FROM gsa_app;
