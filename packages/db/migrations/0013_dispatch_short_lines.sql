-- M7 (OQ-019): a dispatched sale line may arrive entirely short and stay at 0 packs.
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_packs_positive";--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_packs_non_negative" CHECK ("sale_lines"."packs" >= 0);