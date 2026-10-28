-- M13: the store statement (IMP-010, ADR-0059). A statement is asked for, printed by the worker, and kept as a stored
-- file of the new kind STORE_STATEMENT under the storage policy (ADR-0049).
-- MUTABLE ENTITY: store_statements (version, updated_*), while it is printed.
CREATE TYPE "public"."store_statement_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."media_kind" ADD VALUE 'STORE_STATEMENT';--> statement-breakpoint
CREATE TABLE "store_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"status" "store_statement_status" DEFAULT 'PENDING' NOT NULL,
	"media_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"requested_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "store_statements_number_unique" UNIQUE("number"),
	CONSTRAINT "store_statements_ready" CHECK (("store_statements"."status" = 'READY') = ("store_statements"."media_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_statements" ADD CONSTRAINT "store_statements_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_statements_store_id_idx" ON "store_statements" USING btree ("store_id","as_of");--> statement-breakpoint
CREATE INDEX "store_statements_media_id_idx" ON "store_statements" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "store_statements_requested_by_idx" ON "store_statements" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "store_statements_due_idx" ON "store_statements" USING btree ("next_attempt_at") WHERE "store_statements"."status" = 'PENDING';