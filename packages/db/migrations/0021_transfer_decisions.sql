CREATE TYPE "public"."transfer_outcome" AS ENUM('CONFIRMED', 'NOT_RECEIVED');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'TRANSFER_RECORDED' BEFORE 'TARGET_SET';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'TRANSFER_NOT_RECEIVED' BEFORE 'TARGET_SET';--> statement-breakpoint
CREATE TABLE "transfer_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"outcome" "transfer_outcome" NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL,
	"decided_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_decisions_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "transfer_decisions_reason" CHECK ("transfer_decisions"."outcome" = 'CONFIRMED' or btrim(coalesce("transfer_decisions"."reason", '')) <> '')
);
--> statement-breakpoint
ALTER TABLE "transfer_decisions" ADD CONSTRAINT "transfer_decisions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_decisions" ADD CONSTRAINT "transfer_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_decisions" ADD CONSTRAINT "transfer_decisions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_decisions_decided_by_idx" ON "transfer_decisions" USING btree ("decided_by");--> statement-breakpoint
-- ADR-0046, held by the database as well as the service: only a bank transfer
-- is confirmed or found not received. Cash is decided at its settlement.
CREATE FUNCTION transfer_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.method = 'BANK_TRANSFER') THEN
    RAISE EXCEPTION 'payment % is not a bank transfer', NEW.payment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transfer_decisions_bank_transfer';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transfer_decisions_guard AFTER INSERT ON transfer_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transfer_decisions_guard();
--> statement-breakpoint
-- APPEND-ONLY: a decision is final (ADR-0046).
REVOKE UPDATE, DELETE, TRUNCATE ON "transfer_decisions" FROM gsa_app;
