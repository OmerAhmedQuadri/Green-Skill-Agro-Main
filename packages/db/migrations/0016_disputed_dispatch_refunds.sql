ALTER TYPE "public"."return_condition" ADD VALUE 'NOT_RECEIVED';--> statement-breakpoint
CREATE TABLE "refund_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"cash_ledger_entry_id" uuid NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_payments_amount_positive" CHECK ("refund_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "returns" DROP CONSTRAINT "returns_split";--> statement-breakpoint
ALTER TABLE "returns" DROP CONSTRAINT "returns_collected";--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "refund_due" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_cash_ledger_entry_id_cash_ledger_entries_id_fk" FOREIGN KEY ("cash_ledger_entry_id") REFERENCES "public"."cash_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_payments_return_id_idx" ON "refund_payments" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "refund_payments_seller_id_idx" ON "refund_payments" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "refund_payments_cash_ledger_entry_id_idx" ON "refund_payments" USING btree ("cash_ledger_entry_id");--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_split" CHECK ("returns"."amount" = "returns"."to_sale" + "returns"."to_other_debts" + "returns"."refund" + "returns"."refund_due" and "returns"."to_sale" >= 0 and "returns"."to_other_debts" >= 0 and "returns"."refund" >= 0 and "returns"."refund_due" >= 0);--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_collected" CHECK ("returns"."collected_portion" = "returns"."to_other_debts" + "returns"."refund" + "returns"."refund_due");--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "refund_payments" FROM gsa_app;
