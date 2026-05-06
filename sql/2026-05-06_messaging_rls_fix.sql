-- ════════════════════════════════════════════════════════════════════
-- Fix RLS so non-admin users can actually send messages, mark them read,
-- and update their own pending elections (e.g. withdrawing).
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "user inserts own messages" ON public.prep_messages;
CREATE POLICY "user inserts own messages" ON public.prep_messages
  FOR INSERT WITH CHECK (sender_id = auth.uid());

DROP POLICY IF EXISTS "user marks own as read" ON public.prep_messages;
CREATE POLICY "user marks own as read" ON public.prep_messages
  FOR UPDATE USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS "user updates own elections" ON public.prep_pcm_elections;
CREATE POLICY "user updates own elections" ON public.prep_pcm_elections
  FOR UPDATE USING (elector_id = auth.uid());
