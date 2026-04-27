-- SplitCat database schema
-- Run against the `splitcat` database on first deploy.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- A "group" is a Telegram chat where the bot is active.
-- One group = one running ledger (simpler than per-trip for v1).
CREATE TABLE groups (
  id              BIGINT PRIMARY KEY,               -- Telegram chat_id
  title           TEXT,
  home_currency   TEXT NOT NULL DEFAULT 'SGD',      -- ISO 4217
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A member is a Telegram user seen in a group. Keyed on Telegram user_id
-- (stable across username changes, which people do).
CREATE TABLE members (
  group_id        BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL,                  -- Telegram user_id
  username        TEXT,                             -- @handle, may change
  display_name    TEXT NOT NULL,                    -- First name or custom
  nudges_muted_until TIMESTAMPTZ,                   -- for /snooze
  PRIMARY KEY (group_id, user_id)
);

-- A parsed receipt. `raw_ocr` holds Claude's full vision response for audit/debug.
CREATE TABLE receipts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  uploaded_by     BIGINT NOT NULL,                  -- Telegram user_id
  merchant        TEXT,
  receipt_date    DATE,
  currency        TEXT NOT NULL,                    -- ISO 4217, e.g. 'JPY'
  subtotal        NUMERIC(12,2) NOT NULL,
  service_charge  NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax             NUMERIC(12,2) NOT NULL DEFAULT 0, -- GST / VAT / sales tax
  tip             NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL,
  -- FX snapshot at time of entry
  fx_rate         NUMERIC(14,8),                    -- 1 unit of `currency` = fx_rate units of home_currency
  fx_source       TEXT,                             -- 'user', 'claude-estimate', 'exchangerate-api', etc.
  home_currency   TEXT NOT NULL,                    -- copied from group at time of entry
  photo_file_id   TEXT,                             -- Telegram file_id for re-fetching
  raw_ocr         JSONB,                            -- full Claude response
  status          TEXT NOT NULL DEFAULT 'pending_assignment',
                  -- pending_assignment | assigned | settled | voided
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_receipts_group ON receipts(group_id, created_at DESC);
CREATE INDEX idx_receipts_status ON receipts(status);

-- Individual line items on a receipt.
CREATE TABLE line_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id      UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position        INT NOT NULL,                     -- display order
  description     TEXT NOT NULL,
  quantity        NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,2) NOT NULL,
  line_total      NUMERIC(12,2) NOT NULL            -- quantity * unit_price
);
CREATE INDEX idx_line_items_receipt ON line_items(receipt_id, position);

-- Who had which line item, and in what share (for shared dishes).
-- If an item is split equally among 3 people, there are 3 rows each with share=1.
-- If two people split one dish 70/30, two rows with shares 0.7 and 0.3.
CREATE TABLE line_item_assignments (
  line_item_id    UUID NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL,                  -- Telegram user_id
  share           NUMERIC(6,3) NOT NULL DEFAULT 1,  -- relative weight, not a fraction
  PRIMARY KEY (line_item_id, user_id)
);

-- Who paid the receipt (can be split across payers, e.g. two cards).
CREATE TABLE receipt_payers (
  receipt_id      UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL,
  amount_paid     NUMERIC(12,2) NOT NULL,           -- in receipt currency
  PRIMARY KEY (receipt_id, user_id)
);

-- Direct settlements: "Priya paid Wei S$52 via PayNow"
CREATE TABLE settlements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  from_user_id    BIGINT NOT NULL,
  to_user_id      BIGINT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,           -- in group home_currency
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_settlements_group ON settlements(group_id, created_at DESC);

-- Nudge tracking. One row per (receipt, debtor) pair.
CREATE TABLE nudges (
  receipt_id      UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  debtor_user_id  BIGINT NOT NULL,
  count           INT NOT NULL DEFAULT 0,
  last_nudged_at  TIMESTAMPTZ,
  paid            BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (receipt_id, debtor_user_id)
);
CREATE INDEX idx_nudges_due ON nudges(last_nudged_at) WHERE paid = FALSE;

-- Mini App sessions — short-lived signed tokens for the web UI.
CREATE TABLE mini_app_sessions (
  token           TEXT PRIMARY KEY,
  receipt_id      UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_expiry ON mini_app_sessions(expires_at);

-- Convenience view: current balance per member per group, in home currency.
-- Positive = they are owed money. Negative = they owe.
CREATE OR REPLACE VIEW member_balances AS
WITH
receipt_shares AS (
  -- Each member's share of each receipt, in home currency
  SELECT
    r.group_id,
    r.id AS receipt_id,
    lia.user_id,
    SUM(
      li.line_total * lia.share / total_shares.sum_shares
      * (r.total / NULLIF(r.subtotal, 0))   -- scale up for tax/service/tip
      * COALESCE(r.fx_rate, 1)
    ) AS share_home
  FROM receipts r
  JOIN line_items li ON li.receipt_id = r.id
  JOIN line_item_assignments lia ON lia.line_item_id = li.id
  JOIN LATERAL (
    SELECT SUM(share) AS sum_shares
    FROM line_item_assignments
    WHERE line_item_id = li.id
  ) total_shares ON TRUE
  WHERE r.status IN ('assigned','settled')
  GROUP BY r.group_id, r.id, lia.user_id
),
payments AS (
  -- What each member actually paid out of pocket, in home currency
  SELECT
    r.group_id,
    rp.user_id,
    SUM(rp.amount_paid * COALESCE(r.fx_rate, 1)) AS paid_home
  FROM receipts r
  JOIN receipt_payers rp ON rp.receipt_id = r.id
  WHERE r.status IN ('assigned','settled')
  GROUP BY r.group_id, rp.user_id
),
settled_out AS (
  SELECT group_id, from_user_id AS user_id, SUM(amount) AS amt
  FROM settlements GROUP BY group_id, from_user_id
),
settled_in AS (
  SELECT group_id, to_user_id AS user_id, SUM(amount) AS amt
  FROM settlements GROUP BY group_id, to_user_id
)
SELECT
  m.group_id,
  m.user_id,
  m.display_name,
  COALESCE(p.paid_home, 0)
    - COALESCE((SELECT SUM(share_home) FROM receipt_shares rs WHERE rs.group_id=m.group_id AND rs.user_id=m.user_id), 0)
    + COALESCE((SELECT amt FROM settled_out so WHERE so.group_id=m.group_id AND so.user_id=m.user_id), 0)
    - COALESCE((SELECT amt FROM settled_in si WHERE si.group_id=m.group_id AND si.user_id=m.user_id), 0)
    AS balance
FROM members m
LEFT JOIN payments p ON p.group_id = m.group_id AND p.user_id = m.user_id;
