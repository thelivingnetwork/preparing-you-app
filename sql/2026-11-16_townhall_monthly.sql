-- ─────────────────────────────────────────────────────────────────────────
-- Townhall: weekly → monthly
-- 2026-11-16
--
-- The standing townhall now runs on the FIRST <weekday> of each month (the
-- recurrence maths lives in server/index.js nextOccurrence). The schedule
-- table keeps its shape: weekday/hour/minute/timezone are read as before.
-- This only refreshes the default title. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE prep_townhall_schedule ALTER COLUMN title SET DEFAULT 'Monthly Townhall';

UPDATE prep_townhall_schedule
   SET title = 'Monthly Townhall', updated_at = now()
 WHERE title = 'Weekly Townhall';

-- Upcoming, not-yet-started townhalls that still carry the old default title.
UPDATE prep_townhalls
   SET title = 'Monthly Townhall'
 WHERE title = 'Weekly Townhall'
   AND live_at IS NULL
   AND scheduled_at > now();

-- OPTIONAL: a weekly townhall already created (and announced) for the coming
-- week will still run once. To cancel it and let the server create the next
-- monthly one instead, uncomment:
-- DELETE FROM prep_townhalls
--  WHERE source = 'recurring' AND live_at IS NULL AND scheduled_at > now();
