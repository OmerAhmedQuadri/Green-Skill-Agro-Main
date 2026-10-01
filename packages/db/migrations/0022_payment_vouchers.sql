ALTER TYPE "public"."media_kind" ADD VALUE 'PAYMENT_VOUCHER';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voucher_number" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voucher_photo_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_photo_id_media_assets_id_fk" FOREIGN KEY ("voucher_photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_voucher_number_unique" ON "payments" USING btree ("voucher_number") WHERE "payments"."voucher_number" is not null;--> statement-breakpoint
CREATE INDEX "payments_voucher_photo_id_idx" ON "payments" USING btree ("voucher_photo_id");--> statement-breakpoint
-- ADR-0047, held by the database as well as the service: every payment from
-- here on carries its voucher. NOT VALID because payments are append-only and
-- those recorded before vouchers have none; every new row is checked.
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_required" CHECK ("voucher_number" IS NOT NULL AND "voucher_photo_id" IS NOT NULL) NOT VALID;
