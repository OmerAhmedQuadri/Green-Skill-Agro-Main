-- M2: the stock ledger, batches, purchase orders and goods receipts.
-- LEDGER / APPEND-ONLY (UPDATE and DELETE revoked in 0007): stock_movements,
-- batches, purchase_order_events, goods_receipts, goods_receipt_lines.
-- MUTABLE ENTITIES (version, updated_*): purchase_orders. purchase_order_lines
-- are edited with their order while it is a draft. document_sequences is a counter.
CREATE TYPE "public"."stock_account_kind" AS ENUM('WAREHOUSE', 'VEHICLE', 'DISPATCHED', 'SUPPLIER', 'SOLD', 'WRITTEN_OFF');--> statement-breakpoint
CREATE TYPE "public"."stock_reference_type" AS ENUM('GOODS_RECEIPT', 'SKU_CONVERSION', 'WRITE_OFF', 'VEHICLE_LOADOUT', 'VEHICLE_RETURN', 'SALE', 'DISPATCH_ORDER', 'LOST_ORDER_CLAIM', 'RETURN', 'DEFECTIVE_REPLACEMENT', 'VEHICLE_AUDIT', 'OPENING_BALANCE');--> statement-breakpoint
CREATE TYPE "public"."po_close_reason" AS ENUM('COMPLETE', 'SHORT', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."po_origin" AS ENUM('MANUAL', 'FORECAST');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."receipt_source" AS ENUM('MANUAL', 'IMPORT');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku_id" uuid NOT NULL,
	"lot_number" text,
	"manufactured_on" date,
	"expires_on" date,
	"first_received_at" timestamp with time zone NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "batches_identity" UNIQUE NULLS NOT DISTINCT("sku_id","lot_number","manufactured_on","expires_on"),
	CONSTRAINT "batches_expiry_after_manufacture" CHECK ("batches"."expires_on" > "batches"."manufactured_on")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"account_kind" "stock_account_kind" NOT NULL,
	"warehouse_id" uuid,
	"vehicle_id" uuid,
	"reference_type" "stock_reference_type" NOT NULL,
	"reference_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "stock_movements_quantity_nonzero" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_account_scope" CHECK ((
      "stock_movements"."account_kind" = 'WAREHOUSE' and "stock_movements"."warehouse_id" is not null and "stock_movements"."vehicle_id" is null
    ) or (
      "stock_movements"."account_kind" = 'VEHICLE' and "stock_movements"."vehicle_id" is not null and "stock_movements"."warehouse_id" is null
    ) or (
      "stock_movements"."account_kind" not in ('WAREHOUSE', 'VEHICLE') and "stock_movements"."warehouse_id" is null and "stock_movements"."vehicle_id" is null
    ))
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 2),
	CONSTRAINT "goods_receipt_lines_packs_positive" CHECK ("goods_receipt_lines"."packs" > 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source" "receipt_source" NOT NULL,
	"file_name" text,
	"note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" "po_status",
	"to_status" "po_status" NOT NULL,
	"reason" text,
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"ordered_packs" integer NOT NULL,
	"expected_unit_cost" numeric(14, 2) NOT NULL,
	CONSTRAINT "purchase_order_lines_sku_unique" UNIQUE("purchase_order_id","sku_id"),
	CONSTRAINT "purchase_order_lines_packs_positive" CHECK ("purchase_order_lines"."ordered_packs" > 0),
	CONSTRAINT "purchase_order_lines_cost_non_negative" CHECK ("purchase_order_lines"."expected_unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" "po_status" DEFAULT 'DRAFT' NOT NULL,
	"close_reason" "po_close_reason",
	"close_note" text,
	"origin" "po_origin" DEFAULT 'MANUAL' NOT NULL,
	"expected_arrival" date,
	"notes" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_orders_closed_has_reason" CHECK (("purchase_orders"."status" = 'CLOSED') = ("purchase_orders"."close_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_lot_number_idx" ON "batches" USING btree ("lot_number");--> statement-breakpoint
CREATE INDEX "batches_expires_on_idx" ON "batches" USING btree ("expires_on") WHERE "batches"."expires_on" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_position_idx" ON "stock_movements" USING btree ("batch_id","account_kind","warehouse_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "stock_movements_group_id_idx" ON "stock_movements" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stock_movements_reference_idx" ON "stock_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "stock_movements_occurred_at_idx" ON "stock_movements" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_warehouse_id_idx" ON "stock_movements" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movements_vehicle_id_idx" ON "stock_movements" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_po_line_idx" ON "goods_receipt_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_batch_idx" ON "goods_receipt_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_po_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_warehouse_id_idx" ON "goods_receipts" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "purchase_order_events_po_idx" ON "purchase_order_events" USING btree ("purchase_order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_sku_id_idx" ON "purchase_order_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_id_idx" ON "purchase_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_id_idx" ON "purchase_orders" USING btree ("warehouse_id");