-- M13: an imported payment (IMP-002, ADR-0059) has no photo of its voucher, and a few have no voucher number: the
-- books' own number stays on the imported payment. Every payment taken in the app still needs both (ADR-0047).
-- NOT VALID as before: payments recorded before 0022 have neither.
ALTER TABLE "payments" DROP CONSTRAINT "payments_voucher_required";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_required"
  CHECK ("origin" = 'IMPORT' OR ("voucher_number" IS NOT NULL AND "voucher_photo_id" IS NOT NULL)) NOT VALID;
