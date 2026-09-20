CREATE TYPE "public"."audit_outcome" AS ENUM('MATCH', 'SHORTFALL', 'SURPLUS');--> statement-breakpoint
CREATE TYPE "public"."audit_status" AS ENUM('IN_PROGRESS', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."surplus_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "vehicle_audit_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"audit_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"expected_packs" integer NOT NULL,
	"counted_packs" integer,
	"comment" text,
	"outcome" "audit_outcome",
	"write_off_id" uuid,
	"surplus_status" "surplus_status",
	"surplus_decided_at" timestamp with time zone,
	"surplus_decided_by" uuid,
	"surplus_comment" text,
	"movement_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicle_audit_lines_counts" CHECK ("vehicle_audit_lines"."expected_packs" >= 0 and ("vehicle_audit_lines"."counted_packs" is null or "vehicle_audit_lines"."counted_packs" >= 0)),
	CONSTRAINT "vehicle_audit_lines_surplus_decided" CHECK (("vehicle_audit_lines"."surplus_status" in ('APPROVED', 'REJECTED')) = ("vehicle_audit_lines"."surplus_decided_at" is not null and "vehicle_audit_lines"."surplus_decided_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "vehicle_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"seller_id" uuid,
	"status" "audit_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicle_audits_number_unique" UNIQUE("number"),
	CONSTRAINT "vehicle_audits_closed" CHECK (("vehicle_audits"."status" = 'CLOSED') = ("vehicle_audits"."closed_at" is not null and "vehicle_audits"."closed_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "write_offs" ADD COLUMN "audit_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_audit_id_vehicle_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."vehicle_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_write_off_id_write_offs_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."write_offs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_surplus_decided_by_users_id_fk" FOREIGN KEY ("surplus_decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audit_lines" ADD CONSTRAINT "vehicle_audit_lines_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_audits" ADD CONSTRAINT "vehicle_audits_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_audit_lines_unique" ON "vehicle_audit_lines" USING btree ("audit_id","batch_id");--> statement-breakpoint
CREATE INDEX "vehicle_audit_lines_batch_id_idx" ON "vehicle_audit_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "vehicle_audit_lines_write_off_id_idx" ON "vehicle_audit_lines" USING btree ("write_off_id");--> statement-breakpoint
CREATE INDEX "vehicle_audit_lines_surplus_idx" ON "vehicle_audit_lines" USING btree ("surplus_status");--> statement-breakpoint
CREATE INDEX "vehicle_audit_lines_surplus_decided_by_idx" ON "vehicle_audit_lines" USING btree ("surplus_decided_by");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_audits_one_open" ON "vehicle_audits" USING btree ("vehicle_id") WHERE "vehicle_audits"."status" = 'IN_PROGRESS';--> statement-breakpoint
CREATE INDEX "vehicle_audits_vehicle_closed_idx" ON "vehicle_audits" USING btree ("vehicle_id","closed_at");--> statement-breakpoint
CREATE INDEX "vehicle_audits_seller_id_idx" ON "vehicle_audits" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "vehicle_audits_opened_by_idx" ON "vehicle_audits" USING btree ("opened_by");--> statement-breakpoint
CREATE INDEX "vehicle_audits_closed_by_idx" ON "vehicle_audits" USING btree ("closed_by");--> statement-breakpoint
CREATE INDEX "write_offs_audit_id_idx" ON "write_offs" USING btree ("audit_id");