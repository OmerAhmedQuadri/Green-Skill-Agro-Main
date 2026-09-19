-- M6: sales, discount approval, delivery documents, the cash ledger
-- (SAL-001..011, PRC-008..017, DOC-001..006, ADR-0019, ADR-0037).
-- APPEND-ONLY: sale_line_allocations, delivery_document_sends, cash_ledger_entries
-- (UPDATE and DELETE revoked below). sale_lines may be updated while a discount
-- is decided, never deleted. MUTABLE ENTITIES: sales (version, updated_*),
-- discount_approval_requests (decided_*, closed_at), delivery_documents (the
-- render job's status), audited through audit_log.
CREATE TYPE "public"."cash_ledger_entry_type" AS ENUM('COLLECTION', 'SETTLEMENT_APPROVED', 'DISCREPANCY');--> statement-breakpoint
CREATE TYPE "public"."delivery_document_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."discount_request_status" AS ENUM('PENDING', 'APPROVED', 'REDUCED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."document_send_channel" AS ENUM('SHARE', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."sale_cancel_reason" AS ENUM('REJECTED', 'EXPIRED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISCOUNT_APPROVAL_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISCOUNT_APPROVED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISCOUNT_REDUCED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISCOUNT_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'DISCOUNT_EXPIRED';--> statement-breakpoint
CREATE TABLE "cash_ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"entry_type" "cash_ledger_entry_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "cash_ledger_sign" CHECK (("cash_ledger_entries"."entry_type" = 'COLLECTION' and "cash_ledger_entries"."amount" > 0) or ("cash_ledger_entries"."entry_type" = 'SETTLEMENT_APPROVED' and "cash_ledger_entries"."amount" < 0) or ("cash_ledger_entries"."entry_type" = 'DISCREPANCY' and "cash_ledger_entries"."amount" <> 0))
);
--> statement-breakpoint
CREATE TABLE "delivery_document_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"channel" "document_send_channel" NOT NULL,
	"to_address" text,
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_document_sends_email_address" CHECK (("delivery_document_sends"."channel" = 'EMAIL') = ("delivery_document_sends"."to_address" is not null))
);
--> statement-breakpoint
CREATE TABLE "delivery_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" "delivery_document_status" DEFAULT 'PENDING' NOT NULL,
	"storage_key" text,
	"byte_size" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"rendered_at" timestamp with time zone,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_documents_sale_id_unique" UNIQUE("sale_id"),
	CONSTRAINT "delivery_documents_number_unique" UNIQUE("number"),
	CONSTRAINT "delivery_documents_ready" CHECK (("delivery_documents"."status" = 'READY') = ("delivery_documents"."storage_key" is not null and "delivery_documents"."rendered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "discount_approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"status" "discount_request_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"comment" text,
	"closed_at" timestamp with time zone,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_approval_requests_sale_id_unique" UNIQUE("sale_id"),
	CONSTRAINT "discount_approval_requests_decided" CHECK (("discount_approval_requests"."status" in ('APPROVED', 'REDUCED', 'REJECTED')) = ("discount_approval_requests"."decided_at" is not null and "discount_approval_requests"."decided_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "sale_line_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	CONSTRAINT "sale_line_allocations_batch_unique" UNIQUE("sale_line_id","batch_id"),
	CONSTRAINT "sale_line_allocations_quantity_positive" CHECK ("sale_line_allocations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"ceiling" numeric(6, 3) NOT NULL,
	"requested_discount" numeric(6, 3) NOT NULL,
	"discount" numeric(6, 3) NOT NULL,
	"gross" numeric(14, 2) NOT NULL,
	"discount_amount" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	CONSTRAINT "sale_lines_sku_unique" UNIQUE("sale_id","sku_id"),
	CONSTRAINT "sale_lines_packs_positive" CHECK ("sale_lines"."packs" > 0),
	CONSTRAINT "sale_lines_discount" CHECK ("sale_lines"."discount" >= 0 and "sale_lines"."discount" <= "sale_lines"."requested_discount"),
	CONSTRAINT "sale_lines_total" CHECK ("sale_lines"."total" = "sale_lines"."gross" - "sale_lines"."discount_amount")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"status" "sale_status" NOT NULL,
	"business_date" date NOT NULL,
	"gross" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"ledger_entry_id" uuid,
	"payment_id" uuid,
	"credit_override_id" uuid,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" "sale_cancel_reason",
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sales_completed" CHECK (("sales"."status" = 'COMPLETED') = ("sales"."completed_at" is not null and "sales"."ledger_entry_id" is not null)),
	CONSTRAINT "sales_cancelled" CHECK (("sales"."status" = 'CANCELLED') = ("sales"."cancelled_at" is not null and "sales"."cancel_reason" is not null)),
	CONSTRAINT "sales_total" CHECK ("sales"."total" = "sales"."gross" - "sales"."discount" and "sales"."total" > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_document_sends" ADD CONSTRAINT "delivery_document_sends_document_id_delivery_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."delivery_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_document_sends" ADD CONSTRAINT "delivery_document_sends_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_document_sends" ADD CONSTRAINT "delivery_document_sends_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD CONSTRAINT "delivery_documents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_line_allocations" ADD CONSTRAINT "sale_line_allocations_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_line_allocations" ADD CONSTRAINT "sale_line_allocations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_ledger_entry_id_store_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."store_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_credit_override_id_credit_overrides_id_fk" FOREIGN KEY ("credit_override_id") REFERENCES "public"."credit_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_ledger_entries_seller_idx" ON "cash_ledger_entries" USING btree ("seller_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cash_ledger_entries_reference_idx" ON "cash_ledger_entries" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_ledger_entries_one_collection" ON "cash_ledger_entries" USING btree ("reference_type","reference_id") WHERE "cash_ledger_entries"."entry_type" = 'COLLECTION';--> statement-breakpoint
CREATE INDEX "delivery_document_sends_document_id_idx" ON "delivery_document_sends" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "delivery_documents_due_idx" ON "delivery_documents" USING btree ("next_attempt_at") WHERE "delivery_documents"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "discount_approval_requests_pending_idx" ON "discount_approval_requests" USING btree ("expires_at") WHERE "discount_approval_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "discount_approval_requests_decided_by_idx" ON "discount_approval_requests" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "sale_line_allocations_batch_id_idx" ON "sale_line_allocations" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sale_lines_sku_id_idx" ON "sale_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "sales_seller_id_idx" ON "sales" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_store_id_idx" ON "sales" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_vehicle_id_idx" ON "sales" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "sales_holding_idx" ON "sales" USING btree ("status") WHERE "sales"."status" in ('PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED');--> statement-breakpoint
CREATE INDEX "sales_ledger_entry_id_idx" ON "sales" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "sales_payment_id_idx" ON "sales" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "sales_credit_override_id_idx" ON "sales" USING btree ("credit_override_id");--> statement-breakpoint
-- ADR-0037: cash taken before the cash ledger existed (M5's payments) is cash in hand now.
INSERT INTO "cash_ledger_entries" ("id", "seller_id", "occurred_at", "entry_type", "amount", "reference_type", "reference_id", "branch_id", "created_at", "created_by")
SELECT gen_random_uuid(), "received_by", "received_at", 'COLLECTION', "amount", 'PAYMENT', "id", "branch_id", "created_at", "received_by"
FROM "payments" WHERE "method" = 'CASH';--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "sale_lines" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "sale_line_allocations" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "delivery_document_sends" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "cash_ledger_entries" FROM gsa_app;
