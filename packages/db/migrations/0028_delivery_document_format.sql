-- ADR-0053 (DOC-009): every store gets its Customer ID, GSA-S-0001…, numbered once in the order the stores were made.
ALTER TABLE "stores" ADD COLUMN "code" text;--> statement-breakpoint
UPDATE "stores" s SET "code" = 'GSA-S-' || lpad(n.n::text, 4, '0')
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "stores") n
  WHERE n.id = s.id;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
INSERT INTO "document_sequences" ("key", "value") SELECT 'GSA-S', count(*) FROM "stores" HAVING count(*) > 0
  ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";--> statement-breakpoint
ALTER TABLE "delivery_documents" ADD COLUMN "vat_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "buyer_code" text;--> statement-breakpoint
-- Open sales' buyers, GSA-C-0001…: one per phone, in the order each first bought; one each where no phone was given.
WITH buyers AS (
  SELECT coalesce("buyer_phone", "id"::text) AS who, min("created_at") AS first FROM "sales" WHERE "store_id" IS NULL GROUP BY 1
), numbered AS (
  SELECT who, row_number() OVER (ORDER BY first, who) AS n FROM buyers
)
UPDATE "sales" s SET "buyer_code" = 'GSA-C-' || lpad(numbered.n::text, 4, '0')
  FROM numbered WHERE s."store_id" IS NULL AND numbered.who = coalesce(s."buyer_phone", s."id"::text);--> statement-breakpoint
INSERT INTO "document_sequences" ("key", "value")
  SELECT 'GSA-C', count(DISTINCT "buyer_code") FROM "sales" WHERE "buyer_code" IS NOT NULL HAVING count(DISTINCT "buyer_code") > 0
  ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_buyer_code" CHECK (("sales"."store_id" is null) = ("sales"."buyer_code" is not null));
