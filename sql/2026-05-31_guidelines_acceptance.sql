-- ════════════════════════════════════════════════════════════════════
-- First-run community guidelines gate.
--
-- Records when a member accepted the "Before You Enter" guidelines. The app
-- shows the guidelines screen after sign-in whenever this is NULL, and stamps
-- it on "Accept & Enter" so the gate never shows again.
--
-- No new RLS policy is needed: members already update their own prep_users
-- row (the profile Save flow), and that same UPDATE policy covers this column.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.prep_users
  ADD COLUMN IF NOT EXISTS guidelines_accepted_at TIMESTAMPTZ;
