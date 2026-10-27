-- M13: correction sessions (COR-001, COR-003, ADR-0059). A Super Admin corrects history only inside one,
-- opened with their password and a reason; it ends after an hour or when closed.
-- MUTABLE ENTITY: correction_sessions (version, updated_*), but only its closing may change: who opened it, when and
-- why are kept as written, so the app's UPDATE is limited to the closing columns below. DELETE is revoked.
CREATE TYPE "public"."correction_closing" AS ENUM('KEPT', 'ADDED', 'EDITED');--> statement-breakpoint
CREATE TABLE "correction_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "correction_sessions_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"closed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"closing" "correction_closing",
	"closing_text" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "correction_sessions_hour" CHECK ("correction_sessions"."ends_at" = "correction_sessions"."opened_at" + interval '1 hour'),
	CONSTRAINT "correction_sessions_reason" CHECK (length(btrim("correction_sessions"."reason")) > 0),
	CONSTRAINT "correction_sessions_closed" CHECK (("correction_sessions"."closed_at" is null) = ("correction_sessions"."ended_at" is null)
      and ("correction_sessions"."closed_at" is null) = ("correction_sessions"."closing" is null)
      and ("correction_sessions"."ended_at" is null or ("correction_sessions"."ended_at" >= "correction_sessions"."opened_at" and "correction_sessions"."ended_at" <= "correction_sessions"."ends_at" and "correction_sessions"."ended_at" <= "correction_sessions"."closed_at"))),
	CONSTRAINT "correction_sessions_closing_text" CHECK (case when "correction_sessions"."closing" in ('ADDED', 'EDITED')
      then length(btrim(coalesce("correction_sessions"."closing_text", ''))) > 0 else "correction_sessions"."closing_text" is null end)
);
--> statement-breakpoint
ALTER TABLE "correction_sessions" ADD CONSTRAINT "correction_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_sessions" ADD CONSTRAINT "correction_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_sessions" ADD CONSTRAINT "correction_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_sessions" ADD CONSTRAINT "correction_sessions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "correction_sessions_number_unique" ON "correction_sessions" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "correction_sessions_one_unsettled" ON "correction_sessions" USING btree ("opened_by") WHERE "correction_sessions"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "correction_sessions_opened_by_idx" ON "correction_sessions" USING btree ("opened_by");--> statement-breakpoint
CREATE INDEX "correction_sessions_opened_at_idx" ON "correction_sessions" USING btree ("opened_at");--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "correction_sessions" FROM gsa_app;--> statement-breakpoint
GRANT UPDATE ("closed_at", "ended_at", "closing", "closing_text", "updated_at", "updated_by", "version") ON "correction_sessions" TO gsa_app;
