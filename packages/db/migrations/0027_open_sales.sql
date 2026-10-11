CREATE TYPE "public"."approval_kind" AS ENUM('DISCOUNT', 'OPEN_SALE');--> statement-breakpoint
CREATE TYPE "public"."open_sale_ground" AS ENUM('SWITCHED_OFF', 'ABOVE_LIMIT');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'OPEN_SALE_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'OPEN_SALE_APPROVED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'OPEN_SALE_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'OPEN_SALE_EXPIRED';--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_completed";--> statement-breakpoint
DROP INDEX "sales_daily_rollup_unique";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "ledger_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD COLUMN "kind" "approval_kind" DEFAULT 'DISCOUNT' NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD COLUMN "grounds" "open_sale_ground"[];--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "buyer_phone" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "location_accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ADD CONSTRAINT "sales_daily_rollup_unique" UNIQUE NULLS NOT DISTINCT("day","sku_id","seller_id","store_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_ledger" CHECK (("payments"."store_id" is null) = ("payments"."ledger_entry_id" is null));--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_open_sale" CHECK (("discount_approval_requests"."kind" = 'OPEN_SALE') = ("discount_approval_requests"."grounds" is not null and cardinality("discount_approval_requests"."grounds") > 0) and ("discount_approval_requests"."kind" = 'DISCOUNT' or "discount_approval_requests"."status" <> 'REDUCED'));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_open" CHECK ("sales"."store_id" is not null or ("sales"."channel" = 'VEHICLE' and "sales"."latitude" is not null and "sales"."longitude" is not null and "sales"."ledger_entry_id" is null));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_open_only" CHECK ("sales"."store_id" is null or ("sales"."buyer_name" is null and "sales"."buyer_phone" is null and "sales"."latitude" is null and "sales"."longitude" is null and "sales"."location_accuracy_m" is null));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_completed" CHECK (("sales"."status" = 'COMPLETED') = ("sales"."completed_at" is not null and ("sales"."ledger_entry_id" is not null or ("sales"."store_id" is null and "sales"."payment_id" is not null))));