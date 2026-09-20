CREATE TABLE "reorder_recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"sku_id" uuid NOT NULL,
	"on_hand" integer NOT NULL,
	"in_transit" integer NOT NULL,
	"per_day" numeric(12, 3) NOT NULL,
	"basis_used" text NOT NULL,
	"guide" boolean DEFAULT false NOT NULL,
	"lead_time_days" integer NOT NULL,
	"safety_cover_days" integer NOT NULL,
	"projected_at_arrival" integer NOT NULL,
	"safety_level" integer NOT NULL,
	"suggested_packs" integer NOT NULL,
	"branch_id" uuid NOT NULL,
	CONSTRAINT "reorder_recommendations_basis" CHECK ("reorder_recommendations"."basis_used" in ('TRAILING', 'SEASONAL')),
	CONSTRAINT "reorder_recommendations_suggested" CHECK ("reorder_recommendations"."suggested_packs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales_daily_rollup" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"sku_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"revenue" numeric(14, 2) NOT NULL,
	"returned_packs" integer DEFAULT 0 NOT NULL,
	"returned_value" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"branch_id" uuid NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reorder_recommendations" ADD CONSTRAINT "reorder_recommendations_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_recommendations" ADD CONSTRAINT "reorder_recommendations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ADD CONSTRAINT "sales_daily_rollup_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ADD CONSTRAINT "sales_daily_rollup_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ADD CONSTRAINT "sales_daily_rollup_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_rollup" ADD CONSTRAINT "sales_daily_rollup_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_recommendations_sku_built_unique" ON "reorder_recommendations" USING btree ("sku_id","built_at");--> statement-breakpoint
CREATE INDEX "reorder_recommendations_built_idx" ON "reorder_recommendations" USING btree ("built_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_daily_rollup_unique" ON "sales_daily_rollup" USING btree ("day","sku_id","seller_id","store_id");--> statement-breakpoint
CREATE INDEX "sales_daily_rollup_day_idx" ON "sales_daily_rollup" USING btree ("day");--> statement-breakpoint
CREATE INDEX "sales_daily_rollup_sku_day_idx" ON "sales_daily_rollup" USING btree ("sku_id","day");--> statement-breakpoint
CREATE INDEX "sales_daily_rollup_seller_idx" ON "sales_daily_rollup" USING btree ("seller_id","day");--> statement-breakpoint
CREATE INDEX "sales_daily_rollup_store_idx" ON "sales_daily_rollup" USING btree ("store_id","day");--> statement-breakpoint
-- ADR-0043: both tables are derived from the sales and the ledger, rebuilt by a
-- nightly job. Nothing reads them as a source of truth, so the runtime role may
-- refill them freely — but never edit a row in place, which would hide a rebuild
-- that did not happen.
REVOKE UPDATE ON "sales_daily_rollup" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE ON "reorder_recommendations" FROM gsa_app;
