-- ════════════════════════════════════════════════════════════════════
-- Seed Gregory Williams as an admin + existing (seed) PCM.
--
-- PREREQUISITE: create his login first in Supabase
--   Dashboard → Authentication → Users → Add user (email + password).
-- That fires the on_auth_user_created_prep trigger, which creates his
-- public.prep_users row. THEN run this seed (it matches him by email).
--
-- Because he is added to prep_admins, he is automatically exempt from the
-- "clear the deck" reset (POST /admin/reset-journey) and remains a seed PCM
-- that bootstraps the multiplication chain. Run is idempotent.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- ↓↓↓ EDIT THESE to match the account you created in Supabase ↓↓↓
  v_email     TEXT := 'gregory@hisholychurch.org';
  v_name      TEXT := 'Gregory Williams';
  v_region    TEXT := 'Oregon, USA';   -- shown to applicants
  v_phone     TEXT := NULL;      -- optional
  v_telegram  TEXT := NULL;      -- optional, e.g. '@gregw'
  v_messenger TEXT := NULL;      -- optional
  -- ↑↑↑ EDIT THESE ↑↑↑
  v_uid UUID;
BEGIN
  SELECT id INTO v_uid FROM public.prep_users WHERE lower(email) = lower(v_email);
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No prep_users row for %. Create the login in Supabase Auth first, then re-run.', v_email;
  END IF;

  -- Full admin access (also makes him exempt from /admin/reset-journey).
  INSERT INTO public.prep_admins (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  -- Existing/seed PCM that applicants can choose.
  INSERT INTO public.prep_pcms (id, name, email, phone, telegram, messenger, region, active)
  VALUES (v_uid, v_name, v_email, v_phone, v_telegram, v_messenger, NULLIF(v_region, ''), true)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
        telegram = EXCLUDED.telegram, messenger = EXCLUDED.messenger,
        region = EXCLUDED.region, active = true;

  RAISE NOTICE 'Seeded % (%) as admin + PCM.', v_name, v_email;
END $$;
