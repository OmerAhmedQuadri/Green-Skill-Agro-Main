ALTER TABLE "media_assets" ADD COLUMN "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "kept_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD COLUMN "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD COLUMN "kept_by" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kept_by_users_id_fk" FOREIGN KEY ("kept_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_kept_by_users_id_fk" FOREIGN KEY ("kept_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kept" CHECK (("media_assets"."kept_at" is null) = ("media_assets"."kept_by" is null));--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_purged" CHECK ("delivery_documents"."purged_at" is null or "delivery_documents"."status" = 'READY');--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_kept" CHECK (("delivery_documents"."kept_at" is null) = ("delivery_documents"."kept_by" is null));--> statement-breakpoint
-- ADR-0049: one period per kind of file replaces the single photo setting.
DELETE FROM "system_settings" WHERE "key" = 'media.photo_retention_days';
