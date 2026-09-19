-- M5: stores and credit (STO-001..010, CRD-001..007, ADR-0036).
-- APPEND-ONLY: store_ledger_entries, payments, payment_allocations (UPDATE and
-- DELETE revoked below; a commit-time guard holds the credit ledger's rules).
-- MUTABLE ENTITIES: stores (version, updated_*), store_assignments (ended_*),
-- credit_overrides (used_*), audited through audit_log.
CREATE TYPE "public"."credit_mode" AS ENUM('BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'BANK_TRANSFER');--> statement-breakpoint
CREATE TYPE "public"."store_ledger_entry_type" AS ENUM('SALE', 'PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'STORE_PENDING_APPROVAL';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'STORE_APPROVED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'STORE_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'STORE_ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'CREDIT_OVERRIDE_GRANTED';--> statement-breakpoint
CREATE TABLE "credit_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"business_date" date NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"used_at" timestamp with time zone,
	"used_reference_id" uuid,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"credit_entry_id" uuid NOT NULL,
	"debit_entry_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_credit_entry_id_debit_entry_id_pk" PRIMARY KEY("credit_entry_id","debit_entry_id"),
	CONSTRAINT "payment_allocations_amount_positive" CHECK ("payment_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"received_at" timestamp with time zone NOT NULL,
	"received_by" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_number_unique" UNIQUE("number"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_transfer_reference" CHECK ("payments"."method" <> 'BANK_TRANSFER' or "payments"."reference" is not null)
);
--> statement-breakpoint
CREATE TABLE "store_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"assigned_by" uuid NOT NULL,
	"note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"entry_type" "store_ledger_entry_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"due_on" date,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "store_ledger_amount_nonzero" CHECK ("store_ledger_entries"."amount" <> 0),
	CONSTRAINT "store_ledger_sign" CHECK (("store_ledger_entries"."entry_type" = 'SALE' and "store_ledger_entries"."amount" > 0) or ("store_ledger_entries"."entry_type" in ('PAYMENT', 'CREDIT_NOTE') and "store_ledger_entries"."amount" < 0) or "store_ledger_entries"."entry_type" = 'ADJUSTMENT'),
	CONSTRAINT "store_ledger_debit_due" CHECK (("store_ledger_entries"."amount" > 0) = ("store_ledger_entries"."due_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_name" text NOT NULL,
	"contact_number" text NOT NULL,
	"category" text,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"address" text,
	"cr_number" text,
	"vat_number" text,
	"national_address" text,
	"credit_mode" "credit_mode" NOT NULL,
	"credit_cycle_days" integer,
	"credit_limit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"price_list_id" uuid NOT NULL,
	"status" "store_status" NOT NULL,
	"storefront_media_id" uuid,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_reason" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stores_custom_cycle_days" CHECK (("stores"."credit_mode" = 'CUSTOM') = ("stores"."credit_cycle_days" is not null)),
	CONSTRAINT "stores_credit_limit_non_negative" CHECK ("stores"."credit_limit" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("credit_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_debit_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("debit_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_ledger_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_assignments" ADD CONSTRAINT "store_assignments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_assignments" ADD CONSTRAINT "store_assignments_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_assignments" ADD CONSTRAINT "store_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_assignments" ADD CONSTRAINT "store_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD CONSTRAINT "store_ledger_entries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD CONSTRAINT "store_ledger_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_ledger_entries" ADD CONSTRAINT "store_ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_storefront_media_id_media_assets_id_fk" FOREIGN KEY ("storefront_media_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_overrides_one_open" ON "credit_overrides" USING btree ("store_id","business_date") WHERE "credit_overrides"."used_at" is null;--> statement-breakpoint
CREATE INDEX "credit_overrides_store_id_idx" ON "credit_overrides" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_debit_idx" ON "payment_allocations" USING btree ("debit_entry_id");--> statement-breakpoint
CREATE INDEX "payments_store_id_idx" ON "payments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "payments_received_by_idx" ON "payments" USING btree ("received_by","received_at");--> statement-breakpoint
CREATE INDEX "payments_ledger_entry_id_idx" ON "payments" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_assignments_one_open" ON "store_assignments" USING btree ("store_id") WHERE "store_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "store_assignments_seller_id_idx" ON "store_assignments" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "store_assignments_store_id_idx" ON "store_assignments" USING btree ("store_id","started_at");--> statement-breakpoint
CREATE INDEX "store_ledger_entries_store_idx" ON "store_ledger_entries" USING btree ("store_id","occurred_at");--> statement-breakpoint
CREATE INDEX "store_ledger_entries_reference_idx" ON "store_ledger_entries" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "stores_location_idx" ON "stores" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "stores_status_idx" ON "stores" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stores_price_list_id_idx" ON "stores" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "stores_storefront_media_id_idx" ON "stores" USING btree ("storefront_media_id");--> statement-breakpoint
-- The credit ledger's guarantees, held by the database as well as the
-- services, checked at commit: a store never owes less than nothing (no
-- credit balances in Phase 1); every credit is allocated in full; no debit is
-- settled beyond its amount.
CREATE FUNCTION store_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  balance numeric;
BEGIN
  IF TG_TABLE_NAME = 'store_ledger_entries' THEN
    target := NEW.store_id;
  ELSE
    SELECT store_id INTO target FROM store_ledger_entries WHERE id = NEW.credit_entry_id;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO balance FROM store_ledger_entries WHERE store_id = target;
  IF balance < 0 THEN
    RAISE EXCEPTION 'store % would owe less than nothing', target
      USING ERRCODE = 'check_violation', CONSTRAINT = 'store_balance_non_negative';
  END IF;

  IF EXISTS (
    SELECT 1 FROM store_ledger_entries e WHERE e.store_id = target AND e.amount < 0
      AND -e.amount <> coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.credit_entry_id = e.id), 0)
  ) THEN
    RAISE EXCEPTION 'a credit on store % is not fully allocated', target
      USING ERRCODE = 'check_violation', CONSTRAINT = 'store_credits_allocated';
  END IF;

  IF EXISTS (
    SELECT 1 FROM store_ledger_entries e WHERE e.store_id = target AND e.amount > 0
      AND e.amount < coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.debit_entry_id = e.id), 0)
  ) THEN
    RAISE EXCEPTION 'a debit on store % is settled beyond its amount', target
      USING ERRCODE = 'check_violation', CONSTRAINT = 'store_debits_not_oversettled';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER store_ledger_entries_guard AFTER INSERT ON store_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION store_ledger_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_allocations_guard AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION store_ledger_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "store_ledger_entries" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "payments" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_allocations" FROM gsa_app;
