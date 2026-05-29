-- ════════════════════════════════════════════════════════════════════
-- Restrict "become a PCM" to users who have been granted access to
-- The Living Network.
--
-- Previously any signed-in user could insert their own prep_pcms row
-- (open self-service volunteering). The onboarding workflow now only lets
-- people who have been granted Living Network access (tln_invited_at set)
-- volunteer as a PCM — this is the multiplication loop: existing PCMs grant
-- access, and only those granted may then become PCMs themselves.
--
-- Admins keep full write access via the is_admin() policies from
-- 2026-05-06_prep_admins.sql (RLS permissive policies are OR'd), so they can
-- remain the seed PCMs that bootstrap the chain.
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "user inserts/updates own prep_pcms" ON public.prep_pcms;

CREATE POLICY "tln-granted manage own prep_pcms" ON public.prep_pcms
  FOR ALL
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.prep_users u
      WHERE u.id = auth.uid() AND u.tln_invited_at IS NOT NULL
    )
  );
