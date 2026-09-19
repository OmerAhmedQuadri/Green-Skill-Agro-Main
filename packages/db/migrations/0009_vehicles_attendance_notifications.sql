-- M4: vehicles, attendance, vehicle stock, notifications.
-- APPEND-ONLY: odometer_readings, vehicle_returns, vehicle_return_lines
-- (UPDATE and DELETE revoked below). vehicle_id on the ledger, conversions
-- and write-offs gains its foreign key now that the register exists.
-- MUTABLE ENTITIES: vehicles, vehicle_handovers, vehicle_loadouts,
-- check_in_zones, attendance_days, attendance_sessions, closing_stock_declarations
-- (version, updated_*), audited through audit_log.
CREATE TYPE "public"."notification_kind" AS ENUM('LOAD_ISSUED', 'LOAD_DISPUTED', 'LOAD_CONFIRMED', 'LOAD_CANCELLED', 'HANDOVER_PROPOSED', 'HANDOVER_COMPLETED', 'CHECK_IN_AWAITING_AUTHORISATION', 'CHECK_IN_AUTHORISED', 'DAY_OPENED_ON_BEHALF', 'CLOSING_VARIANCE', 'VEHICLE_RETURN_RECORDED');--> statement-breakpoint
CREATE TYPE "public"."handover_status" AS ENUM('PROPOSED', 'CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status" AS ENUM('ACTIVE', 'MAINTENANCE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."attendance_day_status" AS ENUM('OPEN', 'ON_BREAK', 'CHECKED_OUT', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."attendance_session_status" AS ENUM('AWAITING_AUTHORISATION', 'OPEN', 'CLOSED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."odometer_flag" AS ENUM('BELOW_PREVIOUS', 'GAP_FROM_PREVIOUS', 'BELOW_CHECK_IN', 'DISTANCE_IMPLAUSIBLE');--> statement-breakpoint
CREATE TYPE "public"."odometer_source" AS ENUM('REGISTRATION', 'CHECK_IN', 'CHECK_OUT', 'CORRECTION');--> statement-breakpoint
CREATE TYPE "public"."closing_status" AS ENUM('MATCHED', 'VARIANCE_FLAGGED', 'REVIEWED');--> statement-breakpoint
CREATE TYPE "public"."load_status" AS ENUM('ISSUED', 'CONFIRMED', 'DISPUTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."vehicle_return_reason" AS ENUM('EXPIRY_RECALL', 'REDISTRIBUTION', 'SELLER_LEAVING', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"branch_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"assigned_by" uuid NOT NULL,
	"ended_by" uuid,
	"end_note" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_assignments_period" CHECK ("vehicle_assignments"."ended_at" is null or "vehicle_assignments"."ended_at" >= "vehicle_assignments"."started_at")
);
--> statement-breakpoint
CREATE TABLE "vehicle_handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"outgoing_seller_id" uuid NOT NULL,
	"incoming_seller_id" uuid NOT NULL,
	"status" "handover_status" DEFAULT 'PROPOSED' NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"proposed_by" uuid NOT NULL,
	"outgoing_confirmed_at" timestamp with time zone,
	"incoming_confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"stock_list" jsonb,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicle_handovers_two_sellers" CHECK ("vehicle_handovers"."outgoing_seller_id" <> "vehicle_handovers"."incoming_seller_id"),
	CONSTRAINT "vehicle_handovers_completed" CHECK (("vehicle_handovers"."status" = 'CONFIRMED') = ("vehicle_handovers"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration" text NOT NULL,
	"description" text,
	"status" "vehicle_status" DEFAULT 'ACTIVE' NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicles_registration_unique" UNIQUE("registration")
);
--> statement-breakpoint
CREATE TABLE "attendance_breaks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "attendance_breaks_period" CHECK ("attendance_breaks"."ended_at" is null or "attendance_breaks"."ended_at" >= "attendance_breaks"."started_at")
);
--> statement-breakpoint
CREATE TABLE "attendance_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"vehicle_id" uuid,
	"status" "attendance_day_status" NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_reason" text,
	"closed_at" timestamp with time zone,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attendance_days_one_per_date" UNIQUE("seller_id","work_date"),
	CONSTRAINT "attendance_days_on_behalf_reason" CHECK ("attendance_days"."opened_by" = "attendance_days"."seller_id" or "attendance_days"."opened_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"status" "attendance_session_status" NOT NULL,
	"checked_in_at" timestamp with time zone NOT NULL,
	"check_in_lat" numeric(9, 6),
	"check_in_lng" numeric(9, 6),
	"check_in_accuracy_m" numeric(8, 1),
	"check_in_selfie_id" uuid,
	"check_in_odo_photo_id" uuid,
	"check_in_odometer" integer,
	"check_in_flags" "odometer_flag"[] DEFAULT '{}' NOT NULL,
	"check_in_zone_id" uuid,
	"opened_on_behalf_by" uuid,
	"on_behalf_reason" text,
	"zone_authorised_by" uuid,
	"zone_authorised_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"check_out_lat" numeric(9, 6),
	"check_out_lng" numeric(9, 6),
	"check_out_accuracy_m" numeric(8, 1),
	"check_out_selfie_id" uuid,
	"check_out_odo_photo_id" uuid,
	"check_out_odometer" integer,
	"check_out_flags" "odometer_flag"[] DEFAULT '{}' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_comment" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attendance_sessions_check_in_evidence" CHECK ("attendance_sessions"."opened_on_behalf_by" is not null or (
      "attendance_sessions"."check_in_selfie_id" is not null and "attendance_sessions"."check_in_lat" is not null and "attendance_sessions"."check_in_lng" is not null)),
	CONSTRAINT "attendance_sessions_on_behalf_reason" CHECK (("attendance_sessions"."opened_on_behalf_by" is null) = ("attendance_sessions"."on_behalf_reason" is null)),
	CONSTRAINT "attendance_sessions_closed" CHECK (("attendance_sessions"."status" = 'CLOSED') = ("attendance_sessions"."checked_out_at" is not null)),
	CONSTRAINT "attendance_sessions_check_out_evidence" CHECK ("attendance_sessions"."checked_out_at" is null or (
      "attendance_sessions"."check_out_selfie_id" is not null and "attendance_sessions"."check_out_lat" is not null and "attendance_sessions"."check_out_lng" is not null))
);
--> statement-breakpoint
CREATE TABLE "check_in_zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"radius_m" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "check_in_zones_radius" CHECK ("check_in_zones"."radius_m" between 25 and 50000)
);
--> statement-breakpoint
CREATE TABLE "odometer_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"reading_km" integer NOT NULL,
	"source" "odometer_source" NOT NULL,
	"session_id" uuid,
	"photo_id" uuid,
	"note" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odometer_readings_non_negative" CHECK ("odometer_readings"."reading_km" >= 0),
	CONSTRAINT "odometer_readings_correction_note" CHECK ("odometer_readings"."source" <> 'CORRECTION' or "odometer_readings"."note" is not null)
);
--> statement-breakpoint
CREATE TABLE "closing_stock_declarations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"attendance_day_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"status" "closing_status" NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_comment" text,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "closing_stock_one_per_day" UNIQUE("seller_id","work_date"),
	CONSTRAINT "closing_stock_reviewed" CHECK (("closing_stock_declarations"."status" = 'REVIEWED') = ("closing_stock_declarations"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "closing_stock_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"declaration_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"declared_packs" integer NOT NULL,
	"system_packs" integer NOT NULL,
	CONSTRAINT "closing_stock_lines_sku_unique" UNIQUE("declaration_id","sku_id"),
	CONSTRAINT "closing_stock_lines_non_negative" CHECK ("closing_stock_lines"."declared_packs" >= 0 and "closing_stock_lines"."system_packs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_loadout_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"loadout_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2),
	"dispute_note" text,
	CONSTRAINT "vehicle_loadout_lines_batch_unique" UNIQUE("loadout_id","batch_id"),
	CONSTRAINT "vehicle_loadout_lines_packs_positive" CHECK ("vehicle_loadout_lines"."packs" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_loadouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" "load_status" DEFAULT 'ISSUED' NOT NULL,
	"load_value" numeric(14, 2) NOT NULL,
	"vehicle_value" numeric(14, 2) NOT NULL,
	"ceiling" numeric(14, 2),
	"ceiling_acknowledged" boolean DEFAULT false NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"dispute_comment" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"movement_group_id" uuid,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicle_loadouts_number_unique" UNIQUE("number"),
	CONSTRAINT "vehicle_loadouts_confirmed" CHECK (("vehicle_loadouts"."status" = 'CONFIRMED') = ("vehicle_loadouts"."movement_group_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "vehicle_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"packs" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "vehicle_return_lines_batch_unique" UNIQUE("return_id","batch_id"),
	CONSTRAINT "vehicle_return_lines_packs_positive" CHECK ("vehicle_return_lines"."packs" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"seller_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"reason" "vehicle_return_reason" NOT NULL,
	"note" text,
	"movement_group_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_returns_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_outgoing_seller_id_users_id_fk" FOREIGN KEY ("outgoing_seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_incoming_seller_id_users_id_fk" FOREIGN KEY ("incoming_seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_handovers" ADD CONSTRAINT "vehicle_handovers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_breaks" ADD CONSTRAINT "attendance_breaks_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_day_id_attendance_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."attendance_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_in_selfie_id_media_assets_id_fk" FOREIGN KEY ("check_in_selfie_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_in_odo_photo_id_media_assets_id_fk" FOREIGN KEY ("check_in_odo_photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_in_zone_id_check_in_zones_id_fk" FOREIGN KEY ("check_in_zone_id") REFERENCES "public"."check_in_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_opened_on_behalf_by_users_id_fk" FOREIGN KEY ("opened_on_behalf_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_zone_authorised_by_users_id_fk" FOREIGN KEY ("zone_authorised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_out_selfie_id_media_assets_id_fk" FOREIGN KEY ("check_out_selfie_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_check_out_odo_photo_id_media_assets_id_fk" FOREIGN KEY ("check_out_odo_photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_zones" ADD CONSTRAINT "check_in_zones_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_zones" ADD CONSTRAINT "check_in_zones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_zones" ADD CONSTRAINT "check_in_zones_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_photo_id_media_assets_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_attendance_day_id_attendance_days_id_fk" FOREIGN KEY ("attendance_day_id") REFERENCES "public"."attendance_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_declarations" ADD CONSTRAINT "closing_stock_declarations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_lines" ADD CONSTRAINT "closing_stock_lines_declaration_id_closing_stock_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."closing_stock_declarations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closing_stock_lines" ADD CONSTRAINT "closing_stock_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadout_lines" ADD CONSTRAINT "vehicle_loadout_lines_loadout_id_vehicle_loadouts_id_fk" FOREIGN KEY ("loadout_id") REFERENCES "public"."vehicle_loadouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadout_lines" ADD CONSTRAINT "vehicle_loadout_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loadouts" ADD CONSTRAINT "vehicle_loadouts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_return_lines" ADD CONSTRAINT "vehicle_return_lines_return_id_vehicle_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."vehicle_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_return_lines" ADD CONSTRAINT "vehicle_return_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_returns" ADD CONSTRAINT "vehicle_returns_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_returns" ADD CONSTRAINT "vehicle_returns_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_returns" ADD CONSTRAINT "vehicle_returns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_returns" ADD CONSTRAINT "vehicle_returns_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_returns" ADD CONSTRAINT "vehicle_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_assignments_one_per_vehicle" ON "vehicle_assignments" USING btree ("vehicle_id") WHERE "vehicle_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_assignments_one_per_seller" ON "vehicle_assignments" USING btree ("seller_id") WHERE "vehicle_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "vehicle_assignments_vehicle_id_idx" ON "vehicle_assignments" USING btree ("vehicle_id","started_at");--> statement-breakpoint
CREATE INDEX "vehicle_assignments_seller_id_idx" ON "vehicle_assignments" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_handovers_one_open" ON "vehicle_handovers" USING btree ("vehicle_id") WHERE "vehicle_handovers"."status" = 'PROPOSED';--> statement-breakpoint
CREATE INDEX "vehicle_handovers_outgoing_idx" ON "vehicle_handovers" USING btree ("outgoing_seller_id");--> statement-breakpoint
CREATE INDEX "vehicle_handovers_incoming_idx" ON "vehicle_handovers" USING btree ("incoming_seller_id");--> statement-breakpoint
CREATE INDEX "vehicles_branch_id_idx" ON "vehicles" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_breaks_one_open" ON "attendance_breaks" USING btree ("session_id") WHERE "attendance_breaks"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "attendance_breaks_session_id_idx" ON "attendance_breaks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "attendance_days_work_date_idx" ON "attendance_days" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "attendance_days_vehicle_id_idx" ON "attendance_days" USING btree ("vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_one_live" ON "attendance_sessions" USING btree ("seller_id") WHERE "attendance_sessions"."status" in ('OPEN', 'AWAITING_AUTHORISATION');--> statement-breakpoint
CREATE INDEX "attendance_sessions_day_id_idx" ON "attendance_sessions" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "attendance_sessions_checked_in_at_idx" ON "attendance_sessions" USING btree ("checked_in_at");--> statement-breakpoint
CREATE INDEX "odometer_readings_vehicle_idx" ON "odometer_readings" USING btree ("vehicle_id","recorded_at");--> statement-breakpoint
CREATE INDEX "odometer_readings_session_id_idx" ON "odometer_readings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "closing_stock_declarations_vehicle_id_idx" ON "closing_stock_declarations" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "closing_stock_declarations_status_idx" ON "closing_stock_declarations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "closing_stock_lines_sku_id_idx" ON "closing_stock_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "vehicle_loadout_lines_batch_id_idx" ON "vehicle_loadout_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "vehicle_loadouts_vehicle_id_idx" ON "vehicle_loadouts" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_loadouts_seller_id_idx" ON "vehicle_loadouts" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "vehicle_loadouts_status_idx" ON "vehicle_loadouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vehicle_return_lines_batch_id_idx" ON "vehicle_return_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "vehicle_returns_vehicle_id_idx" ON "vehicle_returns" USING btree ("vehicle_id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_conversions" ADD CONSTRAINT "sku_conversions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_offs" ADD CONSTRAINT "write_offs_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "odometer_readings" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "vehicle_returns" FROM gsa_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "vehicle_return_lines" FROM gsa_app;
