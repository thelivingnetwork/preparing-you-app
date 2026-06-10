-- ════════════════════════════════════════════════════════════════════
-- Seed 3 active PCMs (Paul Bethke, Doug Scofield, Caleb Eaton) and pair
-- each under Gregory Williams as their Personal Contact Minister.
--
-- PREREQUISITE: each login must exist in Supabase Auth (Add user) so the
-- on_auth_user_created_prep trigger has created their public.prep_users row.
-- This seed matches by email and RAISEs a clear error on anyone missing.
-- Idempotent — safe to re-run. pcm_id is only set when currently empty, so
-- it never stomps a real pairing the person made themselves later.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_gregory UUID;
  r RECORD;
  v_uid UUID;
BEGIN
  -- Gregory Williams — the seed PCM at the top of the multiplication chain.
  SELECT id INTO v_gregory FROM public.prep_users
    WHERE lower(email) = lower('gregory@hisholychurch.org');
  IF v_gregory IS NULL THEN
    RAISE EXCEPTION 'Gregory Williams login not found — seed him first.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('paul@bethkefamily.com', 'Paul Bethke',   'Wisconsin, USA'),
      ('ds1othem@post.com',     'Doug Scofield',  'Oregon, USA'),
      ('eathawk@gmail.com',      'Caleb Eaton',   'Texas, USA')
    ) AS t(email, name, region)
  LOOP
    SELECT id INTO v_uid FROM public.prep_users WHERE lower(email) = lower(r.email);
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'No prep_users row for % — create the login in Supabase Auth first.', r.email;
    END IF;

    -- Normalise display name + region (auth trigger defaults name to email prefix).
    UPDATE public.prep_users
      SET name = r.name, region = COALESCE(NULLIF(r.region, ''), region)
      WHERE id = v_uid;

    -- Promote to an ACTIVE PCM so applicants can elect them.
    INSERT INTO public.prep_pcms (id, name, email, region, active)
    VALUES (v_uid, r.name, r.email, NULLIF(r.region, ''), true)
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name, email = EXCLUDED.email,
          region = EXCLUDED.region, active = true;

    -- Pair them under Gregory as their PCM — only if they don't already have one.
    UPDATE public.prep_users SET pcm_id = v_gregory
      WHERE id = v_uid AND pcm_id IS NULL;

    -- Record the accepted election (elector = person, pcm = Gregory) if absent.
    IF NOT EXISTS (
      SELECT 1 FROM public.prep_pcm_elections
      WHERE elector_id = v_uid AND pcm_id = v_gregory
    ) THEN
      INSERT INTO public.prep_pcm_elections (elector_id, pcm_id, status, responded_at)
      VALUES (v_uid, v_gregory, 'accepted', now());
    END IF;

    RAISE NOTICE 'Seeded % (%) as active PCM, paired under Gregory.', r.name, r.email;
  END LOOP;
END $$;

-- Verify
SELECT u.name, u.email, p.active AS is_pcm, gp.name AS their_pcm
FROM public.prep_pcms p
JOIN public.prep_users u  ON u.id = p.id
LEFT JOIN public.prep_users gp ON gp.id = u.pcm_id
WHERE u.email IN ('paul@bethkefamily.com','ds1othem@post.com','eathawk@gmail.com')
ORDER BY u.name;
