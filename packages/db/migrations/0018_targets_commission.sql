ALTER TYPE "public"."notification_kind" ADD VALUE 'TARGET_SET';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'TARGET_BEHIND_PACE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'TARGET_MISSED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'PERIOD_CLOSED';--> statement-breakpoint
CREATE TABLE "commission_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"period" text NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"goals" jsonb,
	"progress" jsonb NOT NULL,
	"met" boolean,
	"base" numeric(14, 2) NOT NULL,
	"rate_percent" numeric(6, 3),
	"commission" numeric(14, 2),
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_periods_period_format" CHECK ("commission_periods"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "commission_periods_base_not_negative" CHECK ("commission_periods"."base" >= 0),
	CONSTRAINT "commission_periods_rate_range" CHECK ("commission_periods"."rate_percent" is null or "commission_periods"."rate_percent" between 0 and 100),
	CONSTRAINT "commission_periods_rate_with_commission" CHECK (("commission_periods"."rate_percent" is null) = ("commission_periods"."commission" is null))
);
--> statement-breakpoint
CREATE TABLE "seller_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"period" text NOT NULL,
	"revenue" numeric(14, 2),
	"packs_sold" integer,
	"new_stores" integer,
	"collected" numeric(14, 2),
	"note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "seller_targets_period_format" CHECK ("seller_targets"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "seller_targets_positive" CHECK (("seller_targets"."revenue" is null or "seller_targets"."revenue" > 0) and ("seller_targets"."packs_sold" is null or "seller_targets"."packs_sold" > 0)
        and ("seller_targets"."new_stores" is null or "seller_targets"."new_stores" > 0) and ("seller_targets"."collected" is null or "seller_targets"."collected" > 0)),
	CONSTRAINT "seller_targets_not_empty" CHECK (num_nonnulls("seller_targets"."revenue", "seller_targets"."packs_sold", "seller_targets"."new_stores", "seller_targets"."collected") > 0)
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "safety_cover_days" integer;--> statement-breakpoint
ALTER TABLE "commission_periods" ADD CONSTRAINT "commission_periods_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_periods" ADD CONSTRAINT "commission_periods_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_targets" ADD CONSTRAINT "seller_targets_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_targets" ADD CONSTRAINT "seller_targets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_targets" ADD CONSTRAINT "seller_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_targets" ADD CONSTRAINT "seller_targets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_periods_seller_period_unique" ON "commission_periods" USING btree ("seller_id","period");--> statement-breakpoint
CREATE INDEX "commission_periods_period_idx" ON "commission_periods" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_targets_seller_period_unique" ON "seller_targets" USING btree ("seller_id","period");--> statement-breakpoint
CREATE INDEX "seller_targets_period_idx" ON "seller_targets" USING btree ("period");--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_safety_cover_days_positive" CHECK ("skus"."safety_cover_days" is null or "skus"."safety_cover_days" > 0);--> statement-breakpoint
-- COM-008 (ADR-0042): a frozen month is never recalculated. The snapshot is
-- append-only in the database, not merely by convention in the service.
REVOKE UPDATE, DELETE, TRUNCATE ON "commission_periods" FROM gsa_app;
