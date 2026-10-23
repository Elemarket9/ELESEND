-- Migration 040: Unified rider wallet projection, automatic commission-debt recovery from
-- verified digital earnings, configurable debt-based assignment restriction and
-- defence-in-depth "food is never cash" guard.
--
-- Additive only. No historical journal, line, obligation or allocation is rewritten.
-- Money remains integer pesewas (bigint minor units).

-- 0. Pre-migration integrity checks: stop (do not "fix") if legacy data violates invariants.
--    Food orders created before migration 031 may carry CASH terms. If any such order was ever paid
--    or progressed into kitchen/delivery, cash food was actually fulfilled: halt for investigation.
--    Inert legacy rows (never paid, never accepted) are left untouched; guard_food_assignment and the
--    dispatcher already refuse them, and walletReconciliation reports them for operator cancellation.
DO $$ DECLARE inert integer; BEGIN
 IF EXISTS(SELECT 1 FROM food_orders f JOIN shipments s ON s.id=f.shipment_id
           WHERE (s.payment_method='CASH' OR f.payment_method='CASH')
             AND (f.payment_status='PAID' OR f.state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED')
                  OR s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','COMPLETED'))) THEN
  RAISE EXCEPTION 'Fulfilled food order with CASH payment terms: investigate before applying migration 040' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO inert FROM food_orders f JOIN shipments s ON s.id=f.shipment_id WHERE s.payment_method='CASH' OR f.payment_method='CASH';
 IF inert>0 THEN RAISE NOTICE 'Migration 040: % inert legacy CASH food order(s) remain undispatchable; cancel via the food order flow', inert; END IF;
 IF EXISTS(SELECT 1 FROM (
   SELECT j.shipment_id,sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END) AS net
     FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id
    WHERE l.account='rider_payable' GROUP BY j.shipment_id) x WHERE x.net<0) THEN
  RAISE EXCEPTION 'Negative rider_payable detected: investigate before applying migration 040' USING ERRCODE='23514';
 END IF;
END $$;

-- 1. Food orders may only reference non-cash shipments (shipment payment terms are already immutable).
CREATE FUNCTION guard_food_shipment_not_cash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM shipments WHERE id=NEW.shipment_id AND payment_method='CASH') THEN
  RAISE EXCEPTION 'Food orders require upfront digital payment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER food_shipment_not_cash BEFORE INSERT OR UPDATE OF shipment_id ON food_orders
 FOR EACH ROW EXECUTE FUNCTION guard_food_shipment_not_cash();

-- 2. Administrator-configurable rider wallet policy (single row) with immutable change history.
--    max_debt_minor NULL => each rider's existing commission_accounts.max_outstanding_minor applies,
--    so applying this migration does not silently change any rider's current limit.
CREATE TABLE rider_wallet_policy(
 id text PRIMARY KEY DEFAULT 'default' CHECK(id='default'),
 max_debt_minor bigint CHECK(max_debt_minor IS NULL OR max_debt_minor BETWEEN 0 AND 100000000),
 debt_restriction_enabled boolean NOT NULL DEFAULT true,
 auto_recover_from_earnings boolean NOT NULL DEFAULT true,
 repayment_min_minor bigint NOT NULL DEFAULT 100 CHECK(repayment_min_minor BETWEEN 1 AND 100000000),
 repayment_max_minor bigint CHECK(repayment_max_minor IS NULL OR repayment_max_minor BETWEEN 1 AND 1000000000),
 repayment_channels text[] NOT NULL DEFAULT ARRAY['mobile_money','card']::text[]
  CHECK(cardinality(repayment_channels)>=1 AND repayment_channels <@ ARRAY['mobile_money','card','bank_transfer','ussd']::text[]),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(repayment_max_minor IS NULL OR repayment_max_minor>=repayment_min_minor)
);
INSERT INTO rider_wallet_policy(id) VALUES('default') ON CONFLICT DO NOTHING;
CREATE TABLE rider_wallet_policy_history(
 id bigserial PRIMARY KEY,
 revision bigint NOT NULL,
 policy jsonb NOT NULL,
 changed_by uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(reason)>=12),
 changed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(revision)
);
CREATE TRIGGER immutable_rider_wallet_policy_history BEFORE UPDATE OR DELETE ON rider_wallet_policy_history
 FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- 3. Ledger vocabulary for debt recovery. Each ledger stays individually balanced; the two
--    clearing accounts must net to zero across ledgers (verified by reconciliation).
--    Rider ledger:    Dr rider_earnings_offset_clearing / Cr rider_receivable
--    Shipment ledger: Dr rider_payable                  / Cr rider_debt_recovery_clearing
ALTER TABLE finance_journals DROP CONSTRAINT finance_journals_kind_check;
ALTER TABLE finance_journals ADD CONSTRAINT finance_journals_kind_check
 CHECK(kind IN ('cash_commission','credit_purchase','credit_apply','commission_repayment','commission_overpayment','waive','reinstate','earnings_recovery'));
ALTER TABLE finance_lines DROP CONSTRAINT finance_lines_ledger_code_check;
ALTER TABLE finance_lines ADD CONSTRAINT finance_lines_ledger_code_check
 CHECK(ledger_code IN ('rider_receivable','platform_revenue','prepaid_liability','provider_clearing','commission_adjustment','unapplied_provider_funds','rider_earnings_offset_clearing'));
ALTER TABLE checkout_accounting_journals DROP CONSTRAINT checkout_accounting_journals_kind_check;
ALTER TABLE checkout_accounting_journals ADD CONSTRAINT checkout_accounting_journals_kind_check
 CHECK(kind IN ('psp_verified','delivery_completed','verified_unapplied','refund_requested','refund_completed','payout_completed','rider_debt_recovered'));
ALTER TABLE checkout_accounting_lines DROP CONSTRAINT checkout_accounting_lines_account_check;
ALTER TABLE checkout_accounting_lines ADD CONSTRAINT checkout_accounting_lines_account_check
 CHECK(account IN ('provider_receivable','customer_delivery_liability','rider_payable','platform_commission_revenue','customer_refund_liability','restaurant_payable','platform_food_commission_revenue','rider_debt_recovery_clearing'));

-- 4. Immutable evidence linking both halves of every recovery.
CREATE TABLE rider_debt_recoveries(
 id uuid PRIMARY KEY,
 rider_id uuid NOT NULL REFERENCES riders(id),
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 seq integer NOT NULL CHECK(seq>=1),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 finance_journal_id uuid NOT NULL UNIQUE REFERENCES finance_journals(id),
 checkout_journal_id uuid NOT NULL UNIQUE REFERENCES checkout_accounting_journals(id),
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('delivery_earnings','new_commission_debt','payout_precheck','scheduled_recovery')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(shipment_id,seq)
);
CREATE INDEX rider_debt_recoveries_rider ON rider_debt_recoveries(rider_id,created_at DESC);
CREATE TRIGGER immutable_rider_debt_recoveries BEFORE UPDATE OR DELETE ON rider_debt_recoveries
 FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- 5. A proposed payout whose earnings were fully applied to commission debt is superseded,
--    not "failed" (no provider was ever called). Only live payouts block a new proposal.
ALTER TABLE payout_operations DROP CONSTRAINT payout_operations_status_check;
ALTER TABLE payout_operations ADD CONSTRAINT payout_operations_status_check
 CHECK(status IN ('proposed','initiating','pending','needs_review','paid','failed','superseded'));
DROP INDEX payout_operations_one_live;
CREATE UNIQUE INDEX payout_operations_one_live ON payout_operations(shipment_id,kind) WHERE status NOT IN ('failed','superseded');

-- 6. Read paths.
CREATE INDEX IF NOT EXISTS checkout_accounting_journals_shipment ON checkout_accounting_journals(shipment_id);
CREATE INDEX IF NOT EXISTS shipments_rider_state ON shipments(rider_id,state);

-- 7. Debt profile is a projection of the immutable ledger, never a competing editable balance.
CREATE VIEW rider_debt_profiles AS
SELECT r.id AS rider_id,
       coalesce(d.outstanding_minor,0)::bigint AS outstanding_debt_minor,
       ca.max_outstanding_minor AS rider_limit_minor,
       coalesce(p.max_debt_minor,ca.max_outstanding_minor) AS debt_limit_minor,
       (p.debt_restriction_enabled AND coalesce(d.outstanding_minor,0)>0
         AND coalesce(d.outstanding_minor,0)>=coalesce(p.max_debt_minor,ca.max_outstanding_minor)) AS debt_restricted,
       d.last_commission_at,d.last_recovery_at,d.last_repayment_at
  FROM riders r
  JOIN commission_accounts ca ON ca.rider_id=r.id
  CROSS JOIN rider_wallet_policy p
  LEFT JOIN LATERAL (
   SELECT sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor
                   WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END) AS outstanding_minor,
          max(j.created_at) FILTER(WHERE j.kind='cash_commission') AS last_commission_at,
          max(j.created_at) FILTER(WHERE j.kind='earnings_recovery') AS last_recovery_at,
          max(j.created_at) FILTER(WHERE j.kind='commission_repayment') AS last_repayment_at
     FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id
    WHERE j.rider_id=r.id
  ) d ON true
 WHERE p.id='default';
