-- ════════════════════════════════════════════════════════════════════════
--  Fix: every member sees "No Personal Contact Ministers are available yet"
--  (reported 2026-07-14, login giveheed@gmx.com, fresh user post-gateway).
--
--  Root cause (same failure mode as 2026-07-10): the prep_pcms SELECT
--  policy "any signed-in reads prep_pcms" (from the 2026-05-05 initial
--  schema) is missing from the live DB — most likely dropped during the
--  2026-07-09 dashboard RLS session, exactly like the prep_users policy
--  documented in 2026-07-08_pcm_reads_pending_electors.sql. RLS with no
--  SELECT policy returns ZERO ROWS with NO ERROR, so the app renders the
--  empty state and nothing looks broken server-side.
--
--  Idempotent — safe to re-run. Also prints the policy list for both PCM
--  tables so the result can be eyeballed in the same run.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "any signed-in reads prep_pcms" ON public.prep_pcms;
CREATE POLICY "any signed-in reads prep_pcms" ON public.prep_pcms
  FOR SELECT USING (auth.role() = 'authenticated');

-- Verify: both tables' policies after the fix
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('prep_pcms', 'prep_users')
ORDER BY tablename, policyname;
