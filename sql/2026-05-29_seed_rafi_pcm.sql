-- ════════════════════════════════════════════════════════════════════
-- Seed "Rafi" as a SEED PCM (exempt from the reset, NOT an admin).
--
-- PREREQUISITE: Rafi must already have a login (auth.users + prep_users row).
-- Run 2026-05-29_seed_pcm_flag.sql first so prep_pcms.is_seed exists.
--
-- is_seed = true means /admin/reset-journey will spare Rafi's PCM row and
-- progress, so he keeps bootstrapping the chain after a "clear the deck".
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- ↓↓↓ EDIT THESE to match Rafi's account ↓↓↓
  v_email     TEXT := 'rafi.alla@live.ca';
  v_name      TEXT := 'Rafi';
  v_region    TEXT := 'Middle East, Canada';   -- shown to applicants
  v_phone     TEXT := NULL;      -- optional
  v_telegram  TEXT := NULL;      -- optional
  v_messenger TEXT := NULL;      -- optional
  -- ↑↑↑ EDIT THESE ↑↑↑
  v_uid UUID;
BEGIN
  SELECT id INTO v_uid FROM public.prep_users WHERE lower(email) = lower(v_email);
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No prep_users row for %. Create the login in Supabase Auth first, then re-run.', v_email;
  END IF;

  UPDATE public.prep_users
    SET name = v_name, region = COALESCE(NULLIF(v_region, ''), region)
    WHERE id = v_uid;

  -- Active, seed (reset-exempt) PCM — no admin row.
  INSERT INTO public.prep_pcms (id, name, email, phone, telegram, messenger, region, active, is_seed)
  VALUES (v_uid, v_name, v_email, v_phone, v_telegram, v_messenger, NULLIF(v_region, ''), true, true)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
        telegram = EXCLUDED.telegram, messenger = EXCLUDED.messenger,
        region = EXCLUDED.region, active = true, is_seed = true;

  RAISE NOTICE 'Seeded % (%) as a seed PCM (reset-exempt, non-admin).', v_name, v_email;
END $$;
