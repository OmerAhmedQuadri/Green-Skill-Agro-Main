CREATE TYPE "public"."backup_run_status" AS ENUM('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."backup_trigger" AS ENUM('NIGHTLY', 'MANUAL');--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" "backup_trigger" NOT NULL,
	"status" "backup_run_status" NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_runs_requester" CHECK (("backup_runs"."trigger" = 'MANUAL') = ("backup_runs"."requested_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_one_active" ON "backup_runs" USING btree ((true)) WHERE "backup_runs"."status" in ('REQUESTED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "backup_runs_requested_at_idx" ON "backup_runs" USING btree ("requested_at");