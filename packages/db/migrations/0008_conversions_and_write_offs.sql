-- M3: conversions, write-offs, clearance priorities.
-- APPEND-ONLY: sku_conversions (UPDATE and DELETE revoked below).
-- MUTABLE ENTITIES: write_offs (version, updated_*; moves once, SUBMITTED to
-- APPROVED or REJECTED); stock_flags (updated_*), audited through audit_log.
CREATE TYPE "public"."write_off_reason" AS ENUM('DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'CONVERSION_LOSS', 'DEFECTIVE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."write_off_status" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "sku_conversions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_batch_id" uuid NOT NULL,
	"target_batch_id" uuid NOT NULL,
	"account_kind" "stock_account_kind" NOT NULL,
	"warehouse_id" uuid,
	"vehicle_id" uuid,
	"source_packs" integer NOT NULL,
	"target_packs" integer NOT NULL,
	"source_quantity" numeric(14, 3) NOT NULL,
	"target_quantity" numeric(14, 3) NOT NULL,
	"loss_quantity" numeric(14, 3) NOT NULL,
	"reason" text NOT NULL,
	"movement_group_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"performed_at" timestamp with time zone NOT NULL,
	"performed_by" uuid NOT NULL,
	CONSTRAINT "sku_conversions_balanced" CHECK ("sku_conversions"."source_quantity" = "sku_conversions"."target_quantity" + "sku_conversions"."loss_quantity")
);
--> statement-breakpoint
CREATE TABLE "stock_flags" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"prioritised" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "write_offs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"status" "write_off_status" NOT NULL,
	"reason" "write_off_reason" NOT NULL,
	"note" text,
	"batch_id" uuid NOT NULL,
	"account_kind" "stock_account_kind" NOT NULL,
	"warehouse_id" uuid,
	"vehicle_id" uuid,
	"requested_packs" integer,
	"requested_quantity" numeric(14, 3) NOT NULL,
	"approved_quantity" numeric(14, 3),
	"photo_id" uuid,
	"conversion_id" uuid,
	"movement_group_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"submitted_by" uuid NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_comment" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "write_offs_number_unique" UNIQUE("number"),
	CONSTRAINT "write_offs_quantity_positive" CHECK ("write_offs"."requested_quantity" > 0),
	CONSTRAINT "write_offs_decided" CHECK (("write_offs"."status" = 'SUBMITTED') = ("write_offs"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_source_batch_id_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_target_batch_id_batches_id_fk" FOREIGN KEY ("target_batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_flags" ADD CONSTRAINT "stock_flags_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_flags" ADD CONSTRAINT "stock_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_photo_id_media_assets_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_conversion_id_sku_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."sku_conversions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sku_conversions_source_batch_idx" ON "sku_conversions" USING btree ("source_batch_id");--> statement-breakpoint
CREATE INDEX "sku_conversions_target_batch_idx" ON "sku_conversions" USING btree ("target_batch_id");--> statement-breakpoint
CREATE INDEX "sku_conversions_warehouse_id_idx" ON "sku_conversions" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "sku_conversions_performed_at_idx" ON "sku_conversions" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX "write_offs_status_idx" ON "write_offs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "write_offs_batch_id_idx" ON "write_offs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "write_offs_warehouse_id_idx" ON "write_offs" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "write_offs_vehicle_id_idx" ON "write_offs" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "write_offs_photo_id_idx" ON "write_offs" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "write_offs_conversion_id_idx" ON "write_offs" USING btree ("conversion_id");--> statement-breakpoint
CREATE INDEX "write_offs_submitted_by_idx" ON "write_offs" USING btree ("submitted_by");--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "sku_conversions" FROM gsa_app;
