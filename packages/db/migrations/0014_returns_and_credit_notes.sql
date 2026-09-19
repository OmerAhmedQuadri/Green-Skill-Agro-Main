CREATE TYPE "public"."return_condition" AS ENUM('UNCLEARED_PAYMENT', 'DEFECTIVE');--> statement-breakpoint
CREATE TYPE "public"."return_kind" AS ENUM('CREDIT_NOTE', 'REPLACEMENT');--> statement-breakpoint
CREATE TYPE "public"."return_outcome" AS ENUM('RESTOCK', 'WRITE_OFF');--> statement-breakpoint
ALTER TYPE "public"."cash_ledger_entry_type" ADD VALUE 'REFUND';--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"outcome" "return_outcome" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "return_lines_packs_positive" CHECK ("return_lines"."packs" > 0 and "return_lines"."quantity" > 0),
	CONSTRAINT "return_lines_amount" CHECK ("return_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_replacements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "return_replacements_packs_positive" CHECK ("return_replacements"."packs" > 0 and "return_replacements"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"kind" "return_kind" NOT NULL,
	"condition" "return_condition" NOT NULL,
	"sale_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"processed_by" uuid NOT NULL,
	"vehicle_id" uuid,
	"warehouse_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"to_sale" numeric(14, 2) NOT NULL,
	"to_other_debts" numeric(14, 2) NOT NULL,
	"refund" numeric(14, 2) NOT NULL,
	"collected_portion" numeric(14, 2) NOT NULL,
	"store_ledger_entry_id" uuid,
	"cash_ledger_entry_id" uuid,
	"movement_group_id" uuid NOT NULL,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "returns_number_unique" UNIQUE("number"),
	CONSTRAINT "returns_kind" CHECK (("returns"."kind" = 'CREDIT_NOTE' and "returns"."amount" > 0) or ("returns"."kind" = 'REPLACEMENT' and "returns"."amount" = 0 and "returns"."condition" = 'DEFECTIVE' and "returns"."vehicle_id" is not null)),
	CONSTRAINT "returns_split" CHECK ("returns"."amount" = "returns"."to_sale" + "returns"."to_other_debts" + "returns"."refund" and "returns"."to_sale" >= 0 and "returns"."to_other_debts" >= 0 and "returns"."refund" >= 0),
	CONSTRAINT "returns_collected" CHECK ("returns"."collected_portion" = "returns"."to_other_debts" + "returns"."refund"),
	CONSTRAINT "returns_one_place" CHECK ("returns"."vehicle_id" is null or "returns"."warehouse_id" is null),
	CONSTRAINT "returns_ledger" CHECK (("returns"."to_sale" + "returns"."to_other_debts" > 0) = ("returns"."store_ledger_entry_id" is not null)),
	CONSTRAINT "returns_cash" CHECK (("returns"."refund" > 0) = ("returns"."cash_ledger_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" DROP CONSTRAINT "cash_ledger_sign";--> statement-breakpoint
ALTER TABLE "write_offs" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_replacements" ADD CONSTRAINT "return_replacements_return_line_id_return_lines_id_fk" FOREIGN KEY ("return_line_id") REFERENCES "public"."return_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_replacements" ADD CONSTRAINT "return_replacements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_store_ledger_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("store_ledger_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_cash_ledger_entry_id_cash_ledger_entries_id_fk" FOREIGN KEY ("cash_ledger_entry_id") REFERENCES "public"."cash_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_lines_unique" ON "return_lines" USING btree ("return_id","sale_line_id","batch_id","outcome");--> statement-breakpoint
CREATE INDEX "return_lines_sale_line_id_idx" ON "return_lines" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "return_lines_batch_id_idx" ON "return_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_replacements_unique" ON "return_replacements" USING btree ("return_line_id","batch_id");--> statement-breakpoint
CREATE INDEX "return_replacements_batch_id_idx" ON "return_replacements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "returns_sale_id_idx" ON "returns" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "returns_store_id_idx" ON "returns" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "returns_seller_occurred_idx" ON "returns" USING btree ("seller_id","occurred_at");--> statement-breakpoint
CREATE INDEX "returns_processed_by_idx" ON "returns" USING btree ("processed_by");--> statement-breakpoint
CREATE INDEX "returns_vehicle_id_idx" ON "returns" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "returns_warehouse_id_idx" ON "returns" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "returns_store_ledger_entry_id_idx" ON "returns" USING btree ("store_ledger_entry_id");--> statement-breakpoint
CREATE INDEX "returns_cash_ledger_entry_id_idx" ON "returns" USING btree ("cash_ledger_entry_id");--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "write_offs_return_id_idx" ON "write_offs" USING btree ("return_id");--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_sign" CHECK (("cash_ledger_entries"."entry_type" = 'COLLECTION' and "cash_ledger_entries"."amount" > 0) or ("cash_ledger_entries"."entry_type" = 'DISCREPANCY' and "cash_ledger_entries"."amount" <> 0) or ("cash_ledger_entries"."entry_type" not in ('COLLECTION', 'DISCREPANCY') and "cash_ledger_entries"."amount" < 0));--> statement-breakpoint
-- ADR-0039: returns are append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON "returns" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "return_lines" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "return_replacements" FROM gsa_app;
