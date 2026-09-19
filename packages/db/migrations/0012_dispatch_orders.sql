-- M7: warehouse dispatch orders (DSP-001..017, STATE-MACHINES §3, ADR-0038, OQ-019).
-- A dispatch order carries a sale of channel DISPATCH, which has no vehicle.
-- APPEND-ONLY: dispatch_line_batches, dispatch_order_events (UPDATE and DELETE
-- revoked below). MUTABLE ENTITIES: dispatch_orders (version, updated_*),
-- dispatch_order_lines (the receipt), lost_order_claims (decided_*), audited
-- through audit_log.
CREATE TYPE "public"."sale_channel" AS ENUM('VEHICLE', 'DISPATCH');--> statement-breakpoint
CREATE TYPE "public"."confirmation_mode" AS ENUM('IN_PERSON', 'OWNER_WORD');--> statement-breakpoint
CREATE TYPE "public"."dispatch_close_reason" AS ENUM('DELIVERED', 'CANCELLED', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."dispatch_event_type" AS ENUM('RAISED', 'TAKEN', 'RELEASED_BACK', 'RELEASED', 'CONFIRMED', 'RESOLVED', 'CANCELLED', 'CLAIMED', 'CLAIM_APPROVED', 'CLAIM_REJECTED');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('REQUESTED', 'BEING_HANDLED', 'RELEASED', 'DELIVERED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."lost_claim_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."shortfall_resolution" AS ENUM('FROM_VEHICLE', 'FURTHER_ORDER', 'NOT_NEEDED');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISPATCH_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISPATCH_CREATED_FOR_YOU';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISPATCH_RELEASED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISPATCH_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'LOST_CLAIM_RAISED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'LOST_CLAIM_DECIDED';--> statement-breakpoint
ALTER TYPE "public"."sale_cancel_reason" ADD VALUE 'REQUEST_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."sale_cancel_reason" ADD VALUE 'LOST';--> statement-breakpoint
CREATE TABLE "dispatch_line_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "dispatch_line_batches_quantity_positive" CHECK ("dispatch_line_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "dispatch_event_type" NOT NULL,
	"actor_id" uuid,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"received_packs" integer,
	"short_packs" integer,
	"damaged_packs" integer,
	CONSTRAINT "dispatch_order_lines_sale_line_id_unique" UNIQUE("sale_line_id"),
	CONSTRAINT "dispatch_order_lines_packs_positive" CHECK ("dispatch_order_lines"."packs" > 0),
	CONSTRAINT "dispatch_order_lines_receipt" CHECK (("dispatch_order_lines"."received_packs" is null and "dispatch_order_lines"."short_packs" is null and "dispatch_order_lines"."damaged_packs" is null)
      or ("dispatch_order_lines"."received_packs" >= 0 and "dispatch_order_lines"."short_packs" >= 0 and "dispatch_order_lines"."damaged_packs" >= 0 and "dispatch_order_lines"."received_packs" + "dispatch_order_lines"."short_packs" + "dispatch_order_lines"."damaged_packs" = "dispatch_order_lines"."packs"))
);
--> statement-breakpoint
CREATE TABLE "dispatch_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" "dispatch_status" DEFAULT 'REQUESTED' NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"transport_slip_media_id" uuid,
	"transport_note" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmation_mode" "confirmation_mode",
	"resolution" "shortfall_resolution",
	"closed_at" timestamp with time zone,
	"close_reason" "dispatch_close_reason",
	"cancel_reason" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dispatch_orders_number_unique" UNIQUE("number"),
	CONSTRAINT "dispatch_orders_sale_id_unique" UNIQUE("sale_id"),
	CONSTRAINT "dispatch_orders_released" CHECK (("dispatch_orders"."status" in ('RELEASED', 'DELIVERED') or "dispatch_orders"."close_reason" in ('DELIVERED', 'LOST')) = ("dispatch_orders"."released_at" is not null and "dispatch_orders"."transport_slip_media_id" is not null)),
	CONSTRAINT "dispatch_orders_confirmed" CHECK (("dispatch_orders"."confirmed_at" is not null) = ("dispatch_orders"."confirmation_mode" is not null)),
	CONSTRAINT "dispatch_orders_closed" CHECK (("dispatch_orders"."status" = 'CLOSED') = ("dispatch_orders"."closed_at" is not null and "dispatch_orders"."close_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "lost_order_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "lost_claim_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lost_order_claims_decided" CHECK (("lost_order_claims"."status" = 'PENDING') = ("lost_order_claims"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "vehicle_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "channel" "sale_channel" DEFAULT 'VEHICLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_line_batches" ADD CONSTRAINT "dispatch_line_batches_order_line_id_dispatch_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."dispatch_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_line_batches" ADD CONSTRAINT "dispatch_line_batches_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_order_events" ADD CONSTRAINT "dispatch_order_events_order_id_dispatch_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."dispatch_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_order_events" ADD CONSTRAINT "dispatch_order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_order_lines" ADD CONSTRAINT "dispatch_order_lines_order_id_dispatch_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."dispatch_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_order_lines" ADD CONSTRAINT "dispatch_order_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_transport_slip_media_id_media_assets_id_fk" FOREIGN KEY ("transport_slip_media_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_order_claims" ADD CONSTRAINT "lost_order_claims_order_id_dispatch_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."dispatch_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_order_claims" ADD CONSTRAINT "lost_order_claims_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_order_claims" ADD CONSTRAINT "lost_order_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_order_claims" ADD CONSTRAINT "lost_order_claims_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_line_batches_unique" ON "dispatch_line_batches" USING btree ("order_line_id","batch_id");--> statement-breakpoint
CREATE INDEX "dispatch_line_batches_batch_id_idx" ON "dispatch_line_batches" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "dispatch_order_events_order_idx" ON "dispatch_order_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "dispatch_order_events_actor_id_idx" ON "dispatch_order_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "dispatch_order_lines_order_id_idx" ON "dispatch_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "dispatch_orders_status_idx" ON "dispatch_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dispatch_orders_seller_id_idx" ON "dispatch_orders" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "dispatch_orders_store_id_idx" ON "dispatch_orders" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "dispatch_orders_raised_by_idx" ON "dispatch_orders" USING btree ("raised_by");--> statement-breakpoint
CREATE INDEX "dispatch_orders_handled_by_idx" ON "dispatch_orders" USING btree ("handled_by");--> statement-breakpoint
CREATE INDEX "dispatch_orders_released_by_idx" ON "dispatch_orders" USING btree ("released_by");--> statement-breakpoint
CREATE INDEX "dispatch_orders_confirmed_by_idx" ON "dispatch_orders" USING btree ("confirmed_by");--> statement-breakpoint
CREATE INDEX "dispatch_orders_warehouse_id_idx" ON "dispatch_orders" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "dispatch_orders_transport_slip_media_id_idx" ON "dispatch_orders" USING btree ("transport_slip_media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lost_order_claims_one_pending" ON "lost_order_claims" USING btree ("order_id") WHERE "lost_order_claims"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "lost_order_claims_order_id_idx" ON "lost_order_claims" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "lost_order_claims_raised_by_idx" ON "lost_order_claims" USING btree ("raised_by");--> statement-breakpoint
CREATE INDEX "lost_order_claims_decided_by_idx" ON "lost_order_claims" USING btree ("decided_by");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_channel_vehicle" CHECK (("sales"."channel" = 'VEHICLE') = ("sales"."vehicle_id" is not null));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "dispatch_line_batches" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "dispatch_order_events" FROM gsa_app;
