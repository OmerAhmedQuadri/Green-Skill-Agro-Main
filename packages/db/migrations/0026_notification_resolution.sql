CREATE TYPE "public"."request_outcome" AS ENUM('APPROVED', 'REDUCED', 'REJECTED', 'CONFIRMED', 'NOT_RECEIVED', 'REVIEWED', 'AUTHORISED', 'TAKEN', 'RELEASED', 'CANCELLED', 'EXPIRED', 'WITHDRAWN');--> statement-breakpoint
DROP INDEX "notifications_unread_idx";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "outcome" "request_outcome";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_subject_idx" ON "notifications" USING btree ("subject_id") WHERE "notifications"."subject_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null and "notifications"."resolved_at" is null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution" CHECK (("notifications"."resolved_at" is null) = ("notifications"."outcome" is null) and ("notifications"."resolved_by" is null or "notifications"."resolved_at" is not null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolved_subject" CHECK ("notifications"."resolved_at" is null or "notifications"."subject_id" is not null);