-- Cash settlement is independent of delivery state but a normal handover MUST NOT
-- assert completion when its entire delivery fee is reported missing/underpaid.
-- Payment exceptions remain separately auditable; use dispute/failed-return flows.
-- Additive, does not modify the historical 009 migration/checksum.
DO $$ BEGIN
 IF EXISTS(
   SELECT 1 FROM shipments s LEFT JOIN cash_collections cc ON cc.shipment_id=s.id
   WHERE s.payment_method='CASH'
    AND (s.state='COMPLETED' OR (s.cash_payer='sender' AND s.state IN ('PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')))
    AND (cc.shipment_id IS NULL OR cc.rider_id IS DISTINCT FROM s.rider_id
       OR cc.cash_payer IS DISTINCT FROM s.cash_payer OR cc.reported_status<>'reported_full'
       OR cc.reported_minor<>s.amount_minor)
 ) THEN
   RAISE EXCEPTION 'Historical cash handover evidence incomplete: investigate before applying migration 010'
    USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION guard_cash_handovers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.payment_method='CASH' AND
    ((NEW.state='PICKUP_VERIFIED' AND NEW.cash_payer='sender' AND OLD.state IS DISTINCT FROM NEW.state)
      OR (NEW.state='COMPLETED' AND OLD.state IS DISTINCT FROM NEW.state))
    AND NOT EXISTS (
      SELECT 1 FROM cash_collections cc
       WHERE cc.shipment_id=NEW.id AND cc.rider_id=NEW.rider_id
         AND cc.cash_payer=NEW.cash_payer AND cc.reported_status='reported_full'
         AND cc.reported_minor=NEW.amount_minor
    ) THEN
   RAISE EXCEPTION 'Full cash collection evidence required for ordinary handover'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_handover_guard BEFORE UPDATE OF state ON shipments
 FOR EACH ROW EXECUTE FUNCTION guard_cash_handovers();

-- Per-rider late-payment grace is an explicit operator setting; no hidden extension.
ALTER TABLE commission_accounts ADD COLUMN grace_days integer NOT NULL DEFAULT 0
 CHECK(grace_days BETWEEN 0 AND 30);

-- PSP money verified AFTER another repayment/waiver MUST NOT disappear on a rollback.
-- Over-collections remain a separate reconciliation liability, never prepaid credits.
ALTER TABLE finance_journals DROP CONSTRAINT finance_journals_kind_check;
ALTER TABLE finance_journals ADD CONSTRAINT finance_journals_kind_check
 CHECK(kind IN ('cash_commission','credit_purchase','credit_apply','commission_repayment','commission_overpayment','waive','reinstate'));
ALTER TABLE finance_lines DROP CONSTRAINT finance_lines_ledger_code_check;
ALTER TABLE finance_lines ADD CONSTRAINT finance_lines_ledger_code_check
 CHECK(ledger_code IN ('rider_receivable','platform_revenue','prepaid_liability','provider_clearing','commission_adjustment','unapplied_provider_funds'));
