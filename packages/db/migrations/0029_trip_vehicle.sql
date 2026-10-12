ALTER TYPE "public"."notification_kind" ADD VALUE 'TRIP_CLOSED_ON_BEHALF';--> statement-breakpoint
ALTER TABLE "attendance_sessions" DROP CONSTRAINT "attendance_sessions_check_out_evidence";--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "closed_on_behalf_by" uuid;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_closed_on_behalf_by_users_id_fk" FOREIGN KEY ("closed_on_behalf_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_sessions_vehicle_id_idx" ON "attendance_sessions" USING btree ("vehicle_id");--> statement-breakpoint
-- ADR-0056 (ATT-014): each session's vehicle is the one its check-in reading went on. A day opened on the seller's
-- behalf without a reading had the day's; a check-in of the seller's own without one had none (ATT-007).
UPDATE "attendance_sessions" s SET "vehicle_id" = coalesce(
  (SELECT r."vehicle_id" FROM "odometer_readings" r WHERE r."session_id" = s."id" AND r."source" = 'CHECK_IN'
    ORDER BY r."recorded_at", r."created_at" LIMIT 1),
  CASE WHEN s."opened_on_behalf_by" IS NOT NULL THEN d."vehicle_id" END)
  FROM "attendance_days" d WHERE d."id" = s."day_id";--> statement-breakpoint
-- A day's vehicle is now that of its latest session with one; it was its first.
UPDATE "attendance_days" d SET "vehicle_id" = latest."vehicle_id"
  FROM (SELECT DISTINCT ON ("day_id") "day_id", "vehicle_id" FROM "attendance_sessions"
    WHERE "vehicle_id" IS NOT NULL AND "status" <> 'WITHDRAWN' ORDER BY "day_id", "checked_in_at" DESC) latest
  WHERE latest."day_id" = d."id" AND d."vehicle_id" IS DISTINCT FROM latest."vehicle_id";--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_closed_on_behalf" CHECK ("attendance_sessions"."closed_on_behalf_by" is null or "attendance_sessions"."checked_out_at" is not null);--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_out_evidence" CHECK ("attendance_sessions"."checked_out_at" is null or "attendance_sessions"."closed_on_behalf_by" is not null or (
      "attendance_sessions"."check_out_selfie_id" is not null and "attendance_sessions"."check_out_lat" is not null and "attendance_sessions"."check_out_lng" is not null));