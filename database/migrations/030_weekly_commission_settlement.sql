-- Migration 030: Weekly Rider Cash Commission Settlement System
-- Implements calendar-based weekly settlement cycle, MoMo network support,
-- automatic financial restriction flags, and settlement audit notifications.

-- 1. Commission Obligations: tag each obligation with a weekly cycle key (e.g. '2026-W42')
ALTER TABLE commission_obligations ADD COLUMN IF NOT EXISTS week_key VARCHAR(10);
CREATE INDEX IF NOT EXISTS commission_obligations_rider_week ON commission_obligations(rider_id, week_key);

-- 2. Settlement Intents: record Mobile Money network, MSISDN, and immutable receipt numbers
ALTER TABLE settlement_intents ADD COLUMN IF NOT EXISTS momo_network VARCHAR(30);
ALTER TABLE settlement_intents ADD COLUMN IF NOT EXISTS momo_phone VARCHAR(30);
ALTER TABLE settlement_intents ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_intents_receipt_no ON settlement_intents(receipt_number) WHERE receipt_number IS NOT NULL;

-- 3. Riders: explicit financial restriction tracking for overdue weekly cash commission
ALTER TABLE riders ADD COLUMN IF NOT EXISTS financial_restriction VARCHAR(60) CHECK(financial_restriction IN ('OVERDUE_CASH_COMMISSION') OR financial_restriction IS NULL);
ALTER TABLE riders ADD COLUMN IF NOT EXISTS financial_restriction_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS riders_financial_restriction ON riders(financial_restriction) WHERE financial_restriction IS NOT NULL;

-- 4. Weekly Settlement Configuration
CREATE TABLE IF NOT EXISTS weekly_settlement_settings (
  id VARCHAR(20) PRIMARY KEY DEFAULT 'default',
  cutoff_day_of_week INTEGER NOT NULL DEFAULT 1 CHECK(cutoff_day_of_week BETWEEN 1 AND 7), -- 1 = Monday
  cutoff_time_utc TIME NOT NULL DEFAULT '00:00:00',
  grace_hours INTEGER NOT NULL DEFAULT 0 CHECK(grace_hours >= 0),
  default_commission_bps INTEGER NOT NULL DEFAULT 1300 CHECK(default_commission_bps BETWEEN 0 AND 10000),
  reminders_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO weekly_settlement_settings(id) VALUES('default') ON CONFLICT DO NOTHING;

-- 5. Automated Reminders & Settlement Notifications Log
CREATE TABLE IF NOT EXISTS settlement_notifications (
  id UUID PRIMARY KEY,
  rider_id UUID NOT NULL REFERENCES riders(id),
  notification_type VARCHAR(50) NOT NULL,
  week_key VARCHAR(10) NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'sms',
  recipient VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS settlement_notifications_rider_type ON settlement_notifications(rider_id, notification_type, week_key);
