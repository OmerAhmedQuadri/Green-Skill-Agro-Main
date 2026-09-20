CREATE TYPE "public"."ceiling_flag_kind" AS ENUM('CASH_IN_HAND', 'VEHICLE_STOCK_VALUE');--> statement-breakpoint
CREATE TYPE "public"."settlement_route" AS ENUM('BANK_DEPOSIT', 'MANAGER_HANDOVER');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'SETTLEMENT_SUBMITTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'SETTLEMENT_APPROVED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'SETTLEMENT_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'CEILING_BREACHED';--> statement-breakpoint
CREATE TABLE "cash_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"seller_id" uuid NOT NULL,
	"route" "settlement_route" NOT NULL,
	"status" "settlement_status" DEFAULT 'SUBMITTED' NOT NULL,
	"declared_amount" numeric(14, 2) NOT NULL,
	"deposited_on" date,
	"received_by" uuid,
	"photo_id" uuid NOT NULL,
	"note" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"approved_amount" numeric(14, 2),
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_comment" text,
	"cash_ledger_entry_id" uuid,
	"discrepancy_entry_id" uuid,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cash_settlements_number_unique" UNIQUE("number"),
	CONSTRAINT "cash_settlements_declared_positive" CHECK ("cash_settlements"."declared_amount" > 0),
	CONSTRAINT "cash_settlements_route" CHECK (("cash_settlements"."route" = 'BANK_DEPOSIT') = ("cash_settlements"."deposited_on" is not null)),
	CONSTRAINT "cash_settlements_handover" CHECK (("cash_settlements"."route" = 'MANAGER_HANDOVER') = ("cash_settlements"."received_by" is not null)),
	CONSTRAINT "cash_settlements_decided" CHECK (("cash_settlements"."status" = 'SUBMITTED') = ("cash_settlements"."decided_at" is null and "cash_settlements"."decided_by" is null)),
	CONSTRAINT "cash_settlements_approved" CHECK (("cash_settlements"."status" = 'APPROVED') = ("cash_settlements"."approved_amount" is not null and "cash_settlements"."cash_ledger_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "dashboard_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "ceiling_flag_kind" NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"ceiling" numeric(14, 2) NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_notified_at" timestamp with time zone NOT NULL,
	"reminders_sent" numeric(5, 0) DEFAULT '0' NOT NULL,
	"resolved_at" timestamp with time zone,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_flags_amounts_positive" CHECK ("dashboard_flags"."amount" > 0 and "dashboard_flags"."ceiling" > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_photo_id_media_assets_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_cash_ledger_entry_id_cash_ledger_entries_id_fk" FOREIGN KEY ("cash_ledger_entry_id") REFERENCES "public"."cash_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_discrepancy_entry_id_cash_ledger_entries_id_fk" FOREIGN KEY ("discrepancy_entry_id") REFERENCES "public"."cash_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_settlements" ADD CONSTRAINT "cash_settlements_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_flags" ADD CONSTRAINT "dashboard_flags_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_flags" ADD CONSTRAINT "dashboard_flags_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_settlements_seller_id_idx" ON "cash_settlements" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "cash_settlements_status_idx" ON "cash_settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cash_settlements_received_by_idx" ON "cash_settlements" USING btree ("received_by");--> statement-breakpoint
CREATE INDEX "cash_settlements_decided_by_idx" ON "cash_settlements" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "cash_settlements_photo_id_idx" ON "cash_settlements" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "cash_settlements_cash_ledger_entry_id_idx" ON "cash_settlements" USING btree ("cash_ledger_entry_id");--> statement-breakpoint
CREATE INDEX "cash_settlements_discrepancy_entry_id_idx" ON "cash_settlements" USING btree ("discrepancy_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_flags_one_open" ON "dashboard_flags" USING btree ("kind","seller_id") WHERE "dashboard_flags"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "dashboard_flags_seller_id_idx" ON "dashboard_flags" USING btree ("seller_id");--> statement-breakpoint
-- ADR-0040: the flags table is the dashboard's own record; settlements keep their history.
REVOKE DELETE, TRUNCATE ON "cash_settlements" FROM gsa_app;
