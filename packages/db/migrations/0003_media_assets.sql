CREATE TYPE "public"."media_kind" AS ENUM('SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE', 'DEPOSIT_SLIP', 'TRANSPORT_SLIP');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('PENDING', 'READY', 'REJECTED', 'PURGED');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "media_kind" NOT NULL,
	"status" "media_status" DEFAULT 'PENDING' NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer,
	"captured_at" timestamp with time zone,
	"captured_lat" numeric(9, 6),
	"captured_lng" numeric(9, 6),
	"capture_accuracy_m" numeric(8, 1),
	"uploaded_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_uploaded_by_idx" ON "media_assets" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "media_assets_status_created_at_idx" ON "media_assets" USING btree ("status","created_at");