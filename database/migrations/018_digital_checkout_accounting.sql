-- Customer money confirmed by PSP is not guaranteed cleared into our bank.
-- Maintain immutable balanced delivery accounting, separate from rider cash debt.
CREATE TABLE checkout_accounting_journals(
 id uuid PRIMARY KEY,
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 event_key text UNIQUE NOT NULL,
 kind text NOT NULL CHECK(kind IN ('psp_verified','delivery_completed','verified_unapplied')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE checkout_accounting_lines(
 journal_id uuid NOT NULL REFERENCES checkout_accounting_journals(id),
 line_no smallint NOT NULL CHECK(line_no BETWEEN 1 AND 6),
 account text NOT NULL CHECK(account IN ('provider_receivable','customer_delivery_liability','rider_payable','platform_commission_revenue','customer_refund_liability')),
 side text NOT NULL CHECK(side IN ('debit','credit')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 PRIMARY KEY(journal_id,line_no)
);
CREATE FUNCTION assert_checkout_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debits bigint;credits bigint;count_lines int;
BEGIN
 SELECT coalesce(sum(amount_minor) FILTER(WHERE side='debit'),0),
        coalesce(sum(amount_minor) FILTER(WHERE side='credit'),0),count(*)
 INTO debits,credits,count_lines FROM checkout_accounting_lines WHERE journal_id=NEW.id;
 IF count_lines<2 OR debits<>credits THEN RAISE EXCEPTION 'Checkout journal unbalanced' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER checkout_balanced_deferred AFTER INSERT ON checkout_accounting_journals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_checkout_balanced();
CREATE TRIGGER immutable_checkout_journals BEFORE UPDATE OR DELETE ON checkout_accounting_journals FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_checkout_lines BEFORE UPDATE OR DELETE ON checkout_accounting_lines FOR EACH ROW EXECUTE FUNCTION deny_mutation();
-- A late / conflicting / short payment must not disappear. Hold evidence for authorized refund,
-- not a falsely completed delivery or platform revenue. Real PSP refunds still integration-blocked.
CREATE TABLE checkout_unapplied_payments(
 provider text NOT NULL,event_id text NOT NULL,
 intent_id uuid NOT NULL REFERENCES shipment_checkout_intents(id),
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 provider_reference text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency text NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id)
);
CREATE TRIGGER immutable_unapplied_payments BEFORE UPDATE OR DELETE ON checkout_unapplied_payments FOR EACH ROW EXECUTE FUNCTION deny_mutation();
