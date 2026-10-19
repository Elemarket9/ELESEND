-- Cash-first delivery; additive migration. Money is integer pesewas (1 GHS = 100).
-- Existing shipments remain DIGITAL. Never rewrite earlier migration checksums.
ALTER TABLE quotes ADD COLUMN payment_method text NOT NULL DEFAULT 'DIGITAL' CHECK(payment_method IN ('CASH','DIGITAL'));
ALTER TABLE shipments ADD COLUMN payment_method text NOT NULL DEFAULT 'DIGITAL' CHECK(payment_method IN ('CASH','DIGITAL')),
 ADD COLUMN cash_payer text CHECK(cash_payer IN ('sender','recipient'));
ALTER TABLE pricing_policies ADD COLUMN commission_mode text NOT NULL DEFAULT 'percentage' CHECK(commission_mode IN ('percentage','fixed','hybrid')),
 ADD COLUMN commission_fixed_minor integer NOT NULL DEFAULT 0 CHECK(commission_fixed_minor>=0),
 ADD COLUMN commission_cap_minor integer CHECK(commission_cap_minor>=0);
-- The initial shipped invariant assumed every completed shipment had PSP-collected funds.
-- Replace ONLY that constraint, retaining OTP and all other transition controls.
DO $$ DECLARE x record; BEGIN FOR x IN
 SELECT conname FROM pg_constraint WHERE conrelid='shipments'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) ILIKE '%COMPLETED%' AND pg_get_constraintdef(oid) ILIKE '%paid%'
 LOOP EXECUTE format('ALTER TABLE shipments DROP CONSTRAINT %I',x.conname); END LOOP; END $$;
ALTER TABLE shipments ADD CONSTRAINT completed_payment_kind CHECK (state<>'COMPLETED' OR paid OR payment_method='CASH');
-- The old guard_shipment() still enforces server-side rider-bound delivery OTP.
-- Cash never enters ELESEND's custody merely because a rider reports collecting it.
-- Preserve historical DIGITAL 'held' entries; cash entries disclose rider-held evidence.
ALTER TABLE financial_entries DROP CONSTRAINT IF EXISTS financial_entries_payout_status_check;
ALTER TABLE financial_entries ADD CONSTRAINT financial_entries_payout_status_check
 CHECK(payout_status IN ('held','eligible','cash_rider_reported'));
CREATE TABLE cash_collections(
 shipment_id uuid PRIMARY KEY REFERENCES shipments(id),
 rider_id uuid NOT NULL REFERENCES riders(id),
 cash_payer text NOT NULL CHECK(cash_payer IN ('sender','recipient')),
 reported_minor bigint NOT NULL CHECK(reported_minor>=0),
 reported_status text NOT NULL CHECK(reported_status IN ('reported_full','reported_partial','uncollected')),
 report_idempotency_key text NOT NULL,
 reported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(rider_id,report_idempotency_key)
);
CREATE TABLE commission_accounts(
 rider_id uuid PRIMARY KEY REFERENCES riders(id),
 postpaid_enabled boolean NOT NULL DEFAULT true,
 max_outstanding_minor bigint NOT NULL DEFAULT 4000 CHECK(max_outstanding_minor BETWEEN 0 AND 1000000000),
 max_unpaid_jobs integer NOT NULL DEFAULT 20 CHECK(max_unpaid_jobs BETWEEN 0 AND 100000),
 settlement_due_days integer NOT NULL DEFAULT 7 CHECK(settlement_due_days BETWEEN 1 AND 365),
 blocked boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO commission_accounts(rider_id) SELECT id FROM riders ON CONFLICT DO NOTHING;
CREATE TABLE finance_journals(
 id uuid PRIMARY KEY, event_key text UNIQUE NOT NULL,
 rider_id uuid NOT NULL REFERENCES riders(id), shipment_id uuid REFERENCES shipments(id),
 kind text NOT NULL CHECK(kind IN ('cash_commission','credit_purchase','credit_apply','commission_repayment','waive','reinstate')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE finance_lines(
 journal_id uuid NOT NULL REFERENCES finance_journals(id),
 line_no smallint NOT NULL CHECK(line_no BETWEEN 1 AND 20),
 ledger_code text NOT NULL CHECK(ledger_code IN ('rider_receivable','platform_revenue','prepaid_liability','provider_clearing','commission_adjustment')),
 side text NOT NULL CHECK(side IN ('debit','credit')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),
 PRIMARY KEY(journal_id,line_no)
);
CREATE INDEX finance_journals_rider ON finance_journals(rider_id,created_at DESC);
-- Journal must balance when the transaction commits, not merely when the first line is inserted.
CREATE FUNCTION assert_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; cr bigint; n integer;
BEGIN
 SELECT coalesce(sum(amount_minor) FILTER(WHERE side='debit'),0),coalesce(sum(amount_minor) FILTER(WHERE side='credit'),0),count(*)
 INTO d,cr,n FROM finance_lines WHERE journal_id=NEW.id;
 IF n<2 OR d<>cr THEN RAISE EXCEPTION 'Unbalanced financial journal %',NEW.id USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_balanced_journal();
CREATE TRIGGER immutable_journals BEFORE UPDATE OR DELETE ON finance_journals FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON finance_lines FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_cash_reports BEFORE UPDATE OR DELETE ON cash_collections FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE settlement_intents(
 id uuid PRIMARY KEY,rider_id uuid NOT NULL REFERENCES riders(id),
 provider text NOT NULL,provider_reference text,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 kind text NOT NULL CHECK(kind IN ('commission_repayment','credit_purchase')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','expired')),
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
 UNIQUE(rider_id,idempotency_key),UNIQUE(provider,provider_reference)
);
CREATE TABLE settlement_provider_events(
 provider text NOT NULL,event_id text NOT NULL,intent_id uuid NOT NULL REFERENCES settlement_intents(id),
 amount_minor bigint NOT NULL,currency text NOT NULL CHECK(currency='GHS'),
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(provider,event_id)
);
CREATE TRIGGER immutable_settlement_events BEFORE UPDATE OR DELETE ON settlement_provider_events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE finance_adjustment_requests(
 id uuid PRIMARY KEY,rider_id uuid NOT NULL REFERENCES riders(id),
 requested_by uuid NOT NULL REFERENCES users(id),approved_by uuid REFERENCES users(id),
 direction text NOT NULL CHECK(direction IN ('waive','reinstate')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), reason text NOT NULL CHECK(length(reason)>=12),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
);
CREATE INDEX commission_due_idx ON commission_accounts(blocked,postpaid_enabled);
-- No UPDATE on cash collection; report is evidence and a correction must be an audited dispute.
-- Existing immutable financial_entries retained to preserve digital test compatibility.
CREATE FUNCTION protect_cash_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.payment_method IS DISTINCT FROM NEW.payment_method OR OLD.cash_payer IS DISTINCT FROM NEW.cash_payer THEN
   RAISE EXCEPTION 'Payment terms are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_cash_booking_terms BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION protect_cash_terms();
-- Per-job immutable obligations and allocations: distinguish collected from owed and
-- calculate accurate unpaid job counts/due dates without an editable "balance" field.
CREATE TABLE commission_obligations(
 id uuid PRIMARY KEY,shipment_id uuid UNIQUE REFERENCES shipments(id),
 rider_id uuid NOT NULL REFERENCES riders(id),
 original_minor bigint NOT NULL CHECK(original_minor>0),
 due_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commission_obligations_rider_due ON commission_obligations(rider_id,due_at);
CREATE TABLE commission_allocations(
 journal_id uuid NOT NULL REFERENCES finance_journals(id),
 obligation_id uuid NOT NULL REFERENCES commission_obligations(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 PRIMARY KEY(journal_id,obligation_id)
);
CREATE FUNCTION prevent_overallocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original bigint; allocated bigint;
BEGIN
 SELECT original_minor INTO original FROM commission_obligations WHERE id=NEW.obligation_id FOR UPDATE;
 SELECT coalesce(sum(amount_minor),0) INTO allocated FROM commission_allocations WHERE obligation_id=NEW.obligation_id;
 IF original IS NULL OR allocated+NEW.amount_minor>original THEN RAISE EXCEPTION 'Commission allocation exceeds obligation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_commission_allocation BEFORE INSERT ON commission_allocations FOR EACH ROW EXECUTE FUNCTION prevent_overallocation();
CREATE TRIGGER immutable_commission_obligations BEFORE UPDATE OR DELETE ON commission_obligations FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_commission_allocations BEFORE UPDATE OR DELETE ON commission_allocations FOR EACH ROW EXECUTE FUNCTION deny_mutation();
