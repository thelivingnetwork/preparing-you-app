-- ════════════════════════════════════════════════════════════════════
-- Steven Michael Sedillo (stallman207@gmail.com): withdraw his pending
-- election of Paul and seed him directly as an ACTIVE PCM, paired under
-- Gregory like the other seeded PCMs (2026-06-10 seed) so his own journey
-- isn't left stuck at "choose a PCM".
--
-- Mirrors POST /pcm/withdraw's writes (status='withdrawn', pcm_id NULL) —
-- but being SQL, sends none of that endpoint's courtesy emails.
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_uid UUID;
  v_name TEXT;
  v_region TEXT;
  v_gregory UUID;
BEGIN
  SELECT id, name, region INTO v_uid, v_name, v_region
    FROM public.prep_users WHERE lower(email) = 'stallman207@gmail.com';
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No prep_users row for stallman207@gmail.com';
  END IF;

  SELECT id INTO v_gregory FROM public.prep_users
    WHERE lower(email) = lower('gregory@hisholychurch.org');
  IF v_gregory IS NULL THEN
    RAISE EXCEPTION 'Gregory Williams login not found';
  END IF;

  -- 1. Withdraw any active election (his pending election of Paul). Must
  --    happen before inserting the Gregory pairing — the partial unique
  --    index allows only one pending/accepted election per elector.
  UPDATE public.prep_pcm_elections
    SET status = 'withdrawn', responded_at = now()
    WHERE elector_id = v_uid AND status IN ('pending', 'accepted');

  -- 2. Promote to an ACTIVE PCM so applicants can elect him.
  INSERT INTO public.prep_pcms (id, name, email, region, active)
  VALUES (v_uid, COALESCE(v_name, 'Steven Michael Sedillo'),
          'stallman207@gmail.com', NULLIF(COALESCE(v_region, ''), ''), true)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name, email = EXCLUDED.email,
        region = EXCLUDED.region, active = true;

  -- 3. Pair him under Gregory (seed convention) — record the accepted
  --    election and set his pcm_id.
  IF NOT EXISTS (
    SELECT 1 FROM public.prep_pcm_elections
    WHERE elector_id = v_uid AND pcm_id = v_gregory AND status = 'accepted'
  ) THEN
    INSERT INTO public.prep_pcm_elections (elector_id, pcm_id, status, responded_at)
    VALUES (v_uid, v_gregory, 'accepted', now());
  END IF;
  UPDATE public.prep_users SET pcm_id = v_gregory WHERE id = v_uid;

  RAISE NOTICE 'Withdrew Paul election; seeded % as active PCM under Gregory.', v_name;
END $$;

-- Verify
SELECT u.name, u.email, p.active AS is_pcm, gp.name AS their_pcm,
       e.status AS paul_election_status
FROM public.prep_users u
LEFT JOIN public.prep_pcms p ON p.id = u.id
LEFT JOIN public.prep_users gp ON gp.id = u.pcm_id
LEFT JOIN public.prep_pcm_elections e ON e.id = 42
WHERE lower(u.email) = 'stallman207@gmail.com';
