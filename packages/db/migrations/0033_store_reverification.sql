-- M13: imported stores and their re-verification (IMP-005, IMP-008, IMP-009, ADR-0059). A store imported from the
-- books awaits re-verification with only its name and seller; its owner, phone, location and terms are filled in by
-- the seller then, so they are optional in that status alone (stores_details, written without naming the new
-- status, which cannot be used in the transaction that adds it).
-- APPEND-ONLY: store_reverifications, imported_payment_assignments (UPDATE and DELETE revoked below).
CREATE TYPE "public"."balance_confirmation" AS ENUM('AGREED', 'DISPUTED');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'STORE_BALANCE_DISPUTED';--> statement-breakpoint
ALTER TYPE "public"."store_status" ADD VALUE 'AWAITING_REVERIFICATION';--> statement-breakpoint
CREATE TABLE "store_reverifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"imported_balance" numeric(14, 2) NOT NULL,
	"confirmation" "balance_confirmation" NOT NULL,
	"dispute_note" text,
	"reverified_at" timestamp with time zone NOT NULL,
	"reverified_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_reverifications_dispute" CHECK (("store_reverifications"."confirmation" = 'DISPUTED') = ("store_reverifications"."dispute_note" is not null))
);
--> statement-breakpoint
CREATE TABLE "imported_payment_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"imported_payment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "imported_payment_assignments_reason" CHECK (length(btrim("imported_payment_assignments"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "owner_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "contact_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "latitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "longitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "credit_mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "store_reverifications" ADD CONSTRAINT "store_reverifications_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_reverifications" ADD CONSTRAINT "store_reverifications_reverified_by_users_id_fk" FOREIGN KEY ("reverified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_reverifications" ADD CONSTRAINT "store_reverifications_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payment_assignments" ADD CONSTRAINT "imported_payment_assignments_imported_payment_id_imported_payments_id_fk" FOREIGN KEY ("imported_payment_id") REFERENCES "public"."imported_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payment_assignments" ADD CONSTRAINT "imported_payment_assignments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payment_assignments" ADD CONSTRAINT "imported_payment_assignments_session_id_correction_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."correction_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payment_assignments" ADD CONSTRAINT "imported_payment_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_payment_assignments" ADD CONSTRAINT "imported_payment_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_reverifications_store_unique" ON "store_reverifications" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "store_reverifications_reverified_by_idx" ON "store_reverifications" USING btree ("reverified_by");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_payment_assignments_payment_unique" ON "imported_payment_assignments" USING btree ("imported_payment_id");--> statement-breakpoint
CREATE INDEX "imported_payment_assignments_store_id_idx" ON "imported_payment_assignments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "imported_payment_assignments_session_id_idx" ON "imported_payment_assignments" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_import_batch_id_idx" ON "stores" USING btree ("import_batch_id");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_details" CHECK ("stores"."status" not in ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE') or ("stores"."owner_name" is not null
      and "stores"."contact_number" is not null and "stores"."latitude" is not null and "stores"."longitude" is not null and "stores"."credit_mode" is not null));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "store_reverifications" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "imported_payment_assignments" FROM gsa_app;
