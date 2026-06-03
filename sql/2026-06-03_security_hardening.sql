-- ════════════════════════════════════════════════════════════════════
-- Security hardening — 2026-06-03
--
-- Two RLS tightenings discovered in the June security audit. Both are
-- idempotent and safe to re-run.
--
--   1. prep_messages: the recipient could overwrite a received message's
--      BODY (and attachment fields), not just mark it read, because the
--      "participant marks own as read" UPDATE policy placed no restriction
--      on which columns may change. All message writes now go through the
--      server (service_role), so authenticated clients only ever need to
--      flip read_at. We (a) re-create the policy with a WITH CHECK that
--      keeps the row's participants fixed, and (b) use column-level UPDATE
--      privileges so a participant can change ONLY read_at.
--
--   2. prep_admins: the allow-list was readable by every signed-in user,
--      letting anyone enumerate who the admins are. Tighten the read to
--      "your own row, or you are an admin" — enough for the admin app to
--      verify itself and to render the allow-list, but no enumeration for
--      ordinary users. (is_admin() is SECURITY DEFINER, so it still works
--      under the tighter policy without recursion.)
-- ════════════════════════════════════════════════════════════════════

-- ── 1. prep_messages: recipient may only mark-as-read ────────────────────
DROP POLICY IF EXISTS "participant marks own as read" ON public.prep_messages;
CREATE POLICY "participant marks own as read" ON public.prep_messages
  FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- Column-level lockdown: even within their own received rows, an
-- authenticated client can change nothing but read_at. The server
-- (service_role) bypasses these grants for legitimate writes/encryption.
REVOKE UPDATE ON public.prep_messages FROM authenticated;
GRANT  UPDATE (read_at) ON public.prep_messages TO authenticated;

-- ── 2. prep_admins: no enumeration of the admin allow-list ───────────────
DROP POLICY IF EXISTS "any signed-in reads prep_admins" ON public.prep_admins;
DROP POLICY IF EXISTS "read own or admin prep_admins" ON public.prep_admins;
CREATE POLICY "read own or admin prep_admins" ON public.prep_admins
  FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());
