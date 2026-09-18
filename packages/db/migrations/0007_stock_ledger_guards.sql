-- ADR-0001, ADR-0008, DATA-MODEL §3.1: the stock ledger's guarantees, held by
-- the database as well as the services.

-- 1. Every posting group balances per batch, or per variety for a conversion
--    (both batches share a base unit, ADR-0015). 2. No internal account goes
--    negative, and the external ones keep their direction. 3. A count SKU
--    moves in whole seeds. Checked at commit, so the
--    legs of a group can be written in any order within the transaction.
CREATE FUNCTION stock_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced boolean;
  position numeric;
BEGIN
  IF NEW.reference_type = 'SKU_CONVERSION' THEN
    SELECT EXISTS (
      SELECT 1 FROM stock_movements m
      JOIN batches b ON b.id = m.batch_id JOIN skus s ON s.id = b.sku_id
      WHERE m.group_id = NEW.group_id
      GROUP BY coalesce(s.variety_id, s.product_id) HAVING sum(m.quantity) <> 0
    ) INTO unbalanced;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM stock_movements m WHERE m.group_id = NEW.group_id
      GROUP BY m.batch_id HAVING sum(m.quantity) <> 0
    ) INTO unbalanced;
  END IF;
  IF unbalanced THEN
    RAISE EXCEPTION 'stock posting group % does not balance', NEW.group_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_balanced';
  END IF;

  IF NEW.account_kind IN ('WAREHOUSE', 'VEHICLE', 'DISPATCHED') THEN
    SELECT sum(quantity) INTO position FROM stock_movements
    WHERE batch_id = NEW.batch_id AND account_kind = NEW.account_kind
      AND warehouse_id IS NOT DISTINCT FROM NEW.warehouse_id AND vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id;
    IF position < 0 THEN
      RAISE EXCEPTION 'stock position for batch % in % would be negative', NEW.batch_id, NEW.account_kind
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_positions_non_negative';
    END IF;
  END IF;

  -- The external accounts keep their direction too: nothing is un-sold or
  -- un-written-off beyond what was, and nothing goes back to a supplier that
  -- did not come from one.
  IF NEW.account_kind IN ('SOLD', 'WRITTEN_OFF', 'SUPPLIER') THEN
    SELECT sum(quantity) INTO position FROM stock_movements WHERE batch_id = NEW.batch_id AND account_kind = NEW.account_kind;
    IF (NEW.account_kind = 'SUPPLIER' AND position > 0) OR (NEW.account_kind <> 'SUPPLIER' AND position < 0) THEN
      RAISE EXCEPTION 'external stock account % for batch % would change direction', NEW.account_kind, NEW.batch_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_external_positions';
    END IF;
  END IF;

  IF NEW.quantity <> trunc(NEW.quantity) AND EXISTS (
    SELECT 1 FROM batches b JOIN skus s ON s.id = b.sku_id WHERE b.id = NEW.batch_id AND s.measure = 'COUNT'
  ) THEN
    RAISE EXCEPTION 'count SKU moved in part seeds (batch %)', NEW.batch_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_whole_seeds';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_movements_guard
  AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_movements_guard();
--> statement-breakpoint
-- Append-only for the runtime role. Corrections are reversing entries.
REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM gsa_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON batches FROM gsa_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON purchase_order_events FROM gsa_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON goods_receipts FROM gsa_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON goods_receipt_lines FROM gsa_app;
--> statement-breakpoint
-- Positions are derived, never stored (STK-013). A plain view: at this volume a
-- materialised one would only add a way to be stale.
CREATE VIEW stock_positions AS
SELECT batch_id, account_kind, warehouse_id, vehicle_id, sum(quantity) AS quantity
FROM stock_movements
GROUP BY batch_id, account_kind, warehouse_id, vehicle_id
HAVING sum(quantity) <> 0;
