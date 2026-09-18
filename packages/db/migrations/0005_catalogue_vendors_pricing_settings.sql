-- M1: catalogue, vendors, pricing and configuration.
-- Every table here is a MUTABLE ENTITY (CONVENTIONS §8): entities carry
-- version and updated_*; the configuration tables (price_list_items,
-- sku_discount_ceilings, system_settings, feature_toggles, ceilings,
-- commission_rates) carry updated_* and are audited through audit_log (SYS-009).
-- None is a ledger. The catalogue is company-wide, so no branch_id (DATA-MODEL §1.5).
CREATE TYPE "public"."attribute_mode" AS ENUM('HIDDEN', 'OPTIONAL', 'REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."count_unit" AS ENUM('SEED', 'PIECE');--> statement-breakpoint
CREATE TYPE "public"."hybrid_class" AS ENUM('HYBRID', 'NON_HYBRID');--> statement-breakpoint
CREATE TYPE "public"."packaging_type" AS ENUM('CAN', 'POUCH', 'BAG');--> statement-breakpoint
CREATE TYPE "public"."product_attribute" AS ENUM('VARIETY', 'HYBRID', 'COUNTRY_OF_ORIGIN', 'VENDOR', 'LOT_NUMBER', 'MANUFACTURING_DATE', 'EXPIRY', 'SHELF_LIFE');--> statement-breakpoint
CREATE TYPE "public"."sku_measure" AS ENUM('WEIGHT', 'COUNT');--> statement-breakpoint
CREATE TYPE "public"."ceiling_kind" AS ENUM('CASH_IN_HAND', 'VEHICLE_STOCK_VALUE');--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"contact_person" text,
	"phone" text,
	"email" text,
	"country" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vendors_code_unique" UNIQUE("code"),
	CONSTRAINT "vendors_country_iso" CHECK ("vendors"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"expiry_warning_days" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "categories_expiry_warning_days_range" CHECK ("categories"."expiry_warning_days" between 1 and 730)
);
--> statement-breakpoint
CREATE TABLE "product_type_attributes" (
	"product_type_id" uuid NOT NULL,
	"attribute" "product_attribute" NOT NULL,
	"mode" "attribute_mode" NOT NULL,
	CONSTRAINT "product_type_attributes_product_type_id_attribute_pk" PRIMARY KEY("product_type_id","attribute")
);
--> statement-breakpoint
CREATE TABLE "product_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"count_unit" "count_unit" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_type_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"sub_category_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"hybrid" "hybrid_class",
	"country_of_origin" text,
	"vendor_id" uuid,
	"shelf_life_months" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_country_iso" CHECK ("products"."country_of_origin" ~ '^[A-Z]{2}$'),
	CONSTRAINT "products_shelf_life_range" CHECK ("products"."shelf_life_months" between 1 and 240)
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"variety_id" uuid,
	"code" text NOT NULL,
	"code_overridden" boolean DEFAULT false NOT NULL,
	"measure" "sku_measure" NOT NULL,
	"pack_weight_g" numeric(12, 3),
	"pack_count" integer,
	"packaging" "packaging_type" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "skus_code_unique" UNIQUE("code"),
	CONSTRAINT "skus_physical_identity" UNIQUE NULLS NOT DISTINCT("product_id","variety_id","packaging","pack_weight_g","pack_count"),
	CONSTRAINT "skus_pack_size_union" CHECK ((
      "skus"."measure" = 'WEIGHT' and "skus"."pack_weight_g" is not null and "skus"."pack_count" is null and "skus"."pack_weight_g" >= 0.1
    ) or (
      "skus"."measure" = 'COUNT' and "skus"."pack_count" is not null and "skus"."pack_weight_g" is null and "skus"."pack_count" > 0
    ))
);
--> statement-breakpoint
CREATE TABLE "sub_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sub_categories_id_category_unique" UNIQUE("id","category_id")
);
--> statement-breakpoint
CREATE TABLE "varieties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "varieties_id_product_unique" UNIQUE("id","product_id")
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"price_list_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "price_list_items_price_list_id_sku_id_pk" PRIMARY KEY("price_list_id","sku_id"),
	CONSTRAINT "price_list_items_price_positive" CHECK ("price_list_items"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sku_discount_ceilings" (
	"sku_id" uuid PRIMARY KEY NOT NULL,
	"ceiling" numeric(6, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "sku_discount_ceilings_range" CHECK ("sku_discount_ceilings"."ceiling" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "ceilings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "ceiling_kind" NOT NULL,
	"seller_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ceilings_kind_seller_unique" UNIQUE NULLS NOT DISTINCT("kind","seller_id"),
	CONSTRAINT "ceilings_amount_positive" CHECK ("ceilings"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_rates" (
	"seller_id" uuid PRIMARY KEY NOT NULL,
	"on_target_percent" numeric(6, 3) NOT NULL,
	"below_target_percent" numeric(6, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "commission_rates_on_target_range" CHECK ("commission_rates"."on_target_percent" between 0 and 100),
	CONSTRAINT "commission_rates_below_target_range" CHECK ("commission_rates"."below_target_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "feature_toggles" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_attributes" ADD CONSTRAINT "product_type_attributes_product_type_id_product_types_id_fk" FOREIGN KEY ("product_type_id") REFERENCES "public"."product_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_product_type_id_product_types_id_fk" FOREIGN KEY ("product_type_id") REFERENCES "public"."product_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sub_category_fk" FOREIGN KEY ("sub_category_id","category_id") REFERENCES "public"."sub_categories"("id","category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_variety_fk" FOREIGN KEY ("variety_id","product_id") REFERENCES "public"."varieties"("id","product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "varieties" ADD CONSTRAINT "varieties_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "varieties" ADD CONSTRAINT "varieties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "varieties" ADD CONSTRAINT "varieties_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_discount_ceilings" ADD CONSTRAINT "sku_discount_ceilings_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_discount_ceilings" ADD CONSTRAINT "sku_discount_ceilings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceilings" ADD CONSTRAINT "ceilings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceilings" ADD CONSTRAINT "ceilings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rates" ADD CONSTRAINT "commission_rates_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rates" ADD CONSTRAINT "commission_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_toggles" ADD CONSTRAINT "feature_toggles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_en_unique" ON "categories" USING btree (lower("name_en"));--> statement-breakpoint
CREATE UNIQUE INDEX "product_types_name_en_unique" ON "product_types" USING btree (lower("name_en"));--> statement-breakpoint
CREATE UNIQUE INDEX "products_name_en_unique" ON "products" USING btree ("sub_category_id",lower("name_en"));--> statement-breakpoint
CREATE INDEX "products_product_type_id_idx" ON "products" USING btree ("product_type_id");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_vendor_id_idx" ON "products" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "skus_variety_id_idx" ON "skus" USING btree ("variety_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_categories_name_en_unique" ON "sub_categories" USING btree ("category_id",lower("name_en"));--> statement-breakpoint
CREATE UNIQUE INDEX "varieties_name_en_unique" ON "varieties" USING btree ("product_id",lower("name_en"));--> statement-breakpoint
CREATE INDEX "price_list_items_sku_id_idx" ON "price_list_items" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_name_en_unique" ON "price_lists" USING btree (lower("name_en"));--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_single_base" ON "price_lists" USING btree ("is_base") WHERE "price_lists"."is_base";--> statement-breakpoint
CREATE INDEX "ceilings_seller_id_idx" ON "ceilings" USING btree ("seller_id");