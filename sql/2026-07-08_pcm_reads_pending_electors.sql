-- ════════════════════════════════════════════════════════════════════════
--  Fix: a prospective PCM sees "Unknown" for members in the
--  "Elections Awaiting Your Response" list.
--
--  Root cause: prep_users read policy "pcm reads own electors" is
--  (pcm_id = auth.uid()), and prep_users.pcm_id is only set when the PCM
--  ACCEPTS an election. While an election is still 'pending', the elector's
--  pcm_id is NULL, so the prospective PCM has no RLS grant to read that
--  member's row. The client's embedded join elector:elector_id(name,…) then
--  returns null and the UI falls back to "Unknown" — a chicken-and-egg bug:
--  the PCM is asked to Accept/Decline but can't see who is asking.
--
--  Fix: allow a PCM to read the profile of members who have a PENDING
--  election electing them. Read-only, additive, and scoped to exactly the
--  members who deliberately chose this PCM — no broader exposure.
-- ════════════════════════════════════════════════════════════════════════

--  RE-APPLIED 2026-07-10: the policy was found MISSING from the live DB
--  (pg_policies had only 5 prep_users policies) while the bug had resurfaced
--  for Caleb Eaton's two pending elections. Nothing in the repo drops it, so
--  the 07-08 application likely never committed (or was removed during the
--  07-09 dashboard policy work). Verified this time by simulating the PCM's
--  JWT (set_config('request.jwt.claims',…) + set local role authenticated):
--  PCM sees pending electors' rows; an unrelated member sees 0 rows.
--  After any dashboard RLS session, re-check:
--    select policyname from pg_policies where tablename='prep_users';

CREATE POLICY "pcm reads pending electors" ON public.prep_users
  FOR SELECT TO public
  USING (
    id IN (
      SELECT e.elector_id
      FROM public.prep_pcm_elections e
      WHERE e.pcm_id = auth.uid()
        AND e.status = 'pending'
    )
  );
