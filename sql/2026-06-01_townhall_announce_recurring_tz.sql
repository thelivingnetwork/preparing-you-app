-- ─────────────────────────────────────────────────────────────────────────
-- Townhall: per-user timezone, creation announcements, and weekly recurrence
-- 2026-06-01
--
-- Three things:
--   1. prep_users.timezone      — each member's IANA zone (e.g. "America/New_York"),
--                                  captured client-side so townhall emails can show
--                                  the start time in the member's own local time.
--   2. prep_townhalls.announced_at / source
--                                  — announced_at stamps when the "new townhall set"
--                                    email/bell went out (mirrors reminder_sent_at).
--                                  — source distinguishes 'manual' vs 'recurring' rows
--                                    so the recurrence job only cleans up its own.
--   3. prep_townhall_schedule    — a single-row rule table describing the standing
--                                  weekly townhall (e.g. "midday every Saturday").
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Per-user timezone (IANA name). NULL = unknown → emails fall back to host zone.
ALTER TABLE prep_users      ADD COLUMN IF NOT EXISTS timezone TEXT;

-- 2) Townhall announcement + provenance
ALTER TABLE prep_townhalls  ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ;
ALTER TABLE prep_townhalls  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- 3) Standing weekly-townhall rule (one row, id = 1)
CREATE TABLE IF NOT EXISTS prep_townhall_schedule (
  id        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled   BOOLEAN     NOT NULL DEFAULT FALSE,
  weekday   INT         NOT NULL DEFAULT 6 CHECK (weekday BETWEEN 0 AND 6), -- 0=Sun … 6=Sat
  hour      INT         NOT NULL DEFAULT 12 CHECK (hour   BETWEEN 0 AND 23),
  minute    INT         NOT NULL DEFAULT 0  CHECK (minute BETWEEN 0 AND 59),
  timezone  TEXT        NOT NULL DEFAULT 'America/New_York',
  title     TEXT        NOT NULL DEFAULT 'Weekly Townhall',
  topic     TEXT        NOT NULL DEFAULT 'Open discussion',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the single rule row (disabled by default — admin enables it in the panel).
INSERT INTO prep_townhall_schedule (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Only the service role (server) touches the schedule table; clients never do.
ALTER TABLE prep_townhall_schedule ENABLE ROW LEVEL SECURITY;
