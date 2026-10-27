-- M13: what the history import could not settle (IMP-009, ADR-0059), one row each, about one store, imported sale or
-- imported payment. MUTABLE only in its resolution, once: the app may set the resolution columns (column grant) and
-- never change a resolution already made (trigger).
CREATE TYPE "public"."import_warning_kind" AS ENUM('VOUCHER_MISSING', 'VOUCHER_NOT_IN_BOOKS', 'NAME_JOINED_BY_GUESS', 'PAYMENT_NO_STORE', 'PAYMENT_HELD_BACK', 'NAMES_MAY_BE_ONE_STORE', 'LINE_DOES_NOT_ADD_UP', 'LINE_NOT_IN_CATALOGUE', 'LINE_READ_AS_OTHER_PACK', 'DATE_DIFFERS_FROM_STATEMENT', 'RETURN_NOT_IMPORTED', 'BALANCE_DIFFERS_FROM_STATEMENT');--> statement-breakpoint
CREATE TYPE "public"."import_warning_resolution" AS ENUM('KEPT', 'CORRECTED');--> statement-breakpoint
CREATE TABLE "import_warnings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" "import_warning_kind" NOT NULL,
	"store_id" uuid,
	"imported_sale_id" uuid,
	"imported_payment_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" "import_warning_resolution",
	"resolution_note" text,
	"session_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "import_warnings_subject" CHECK (num_nonnulls("import_warnings"."store_id", "import_warnings"."imported_sale_id", "import_warnings"."imported_payment_id") = 1),
	CONSTRAINT "import_warnings_resolved" CHECK (("import_warnings"."resolution" is null) = ("import_warnings"."resolved_at" is null)
      and ("import_warnings"."resolution" is null) = ("import_warnings"."resolved_by" is null)
      and ("import_warnings"."resolution" is null) = (length(btrim(coalesce("import_warnings"."resolution_note", ''))) = 0)),
	CONSTRAINT "import_warnings_corrected" CHECK (coalesce("import_warnings"."resolution" = 'CORRECTED', false) = ("import_warnings"."session_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_imported_sale_id_imported_sales_id_fk" FOREIGN KEY ("imported_sale_id") REFERENCES "public"."imported_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_imported_payment_id_imported_payments_id_fk" FOREIGN KEY ("imported_payment_id") REFERENCES "public"."imported_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_session_id_correction_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."correction_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_warnings_batch_id_idx" ON "import_warnings" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_warnings_store_id_idx" ON "import_warnings" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "import_warnings_imported_sale_id_idx" ON "import_warnings" USING btree ("imported_sale_id");--> statement-breakpoint
CREATE INDEX "import_warnings_imported_payment_id_idx" ON "import_warnings" USING btree ("imported_payment_id");--> statement-breakpoint
CREATE INDEX "import_warnings_session_id_idx" ON "import_warnings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "import_warnings_open_idx" ON "import_warnings" USING btree ("batch_id") WHERE "import_warnings"."resolution" is null;--> statement-breakpoint
CREATE FUNCTION import_warnings_resolved_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution IS NOT NULL THEN
    RAISE EXCEPTION 'import warning % is resolved already', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'import_warnings_resolved_once';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_warnings_resolved_once BEFORE UPDATE ON import_warnings FOR EACH ROW EXECUTE FUNCTION import_warnings_resolved_once();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "import_warnings" FROM gsa_app;--> statement-breakpoint
GRANT UPDATE ("resolution", "resolution_note", "session_id", "resolved_at", "resolved_by") ON "import_warnings" TO gsa_app;
