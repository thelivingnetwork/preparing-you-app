-- ════════════════════════════════════════════════════════════════════
-- Encrypt private messages at rest + blind the admin dashboard.
--
-- Message bodies are encrypted by the server (AES-256-GCM; key lives in the
-- Render env var MESSAGE_ENC_KEY) before being written to prep_messages, so
-- anyone reading the database — including the admin dashboard on the anon
-- key — sees only ciphertext. The server holds the key, so it can decrypt
-- for the two participants and build push previews. This is "blind admin":
-- strong at-rest privacy with a deliberate, audited break-glass path, not
-- zero-knowledge E2EE.
--
-- This migration:
--   1. Locks prep_messages to participants only, removing any admin
--      "read all" policy so the admin dashboard can no longer read rows.
--   2. Stops the INSERT trigger copying message text into the bell
--      notification (prep_notifications). Rich previews still go out via
--      transient web-push, which the server builds from plaintext and never
--      stores.
--   3. Makes the message-attachments bucket PRIVATE (owner-only), so files
--      are reachable only through short-lived signed URLs the server mints
--      for participants (or an audited admin reveal).
--   4. Adds prep_message_access_log to audit every break-glass reveal.
--
-- NOTE: existing message rows stay plaintext until you run the one-time
-- POST /admin/migrate-encrypt-messages (after MESSAGE_ENC_KEY is set).
-- Older attachments stored as public URLs will stop loading once the bucket
-- is private; new attachments use the private path + signed URLs.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Lock prep_messages down to participants only ──────────────────
-- Drop every existing policy (names vary by environment) and recreate
-- exactly the participant policies. The server uses the service role, which
-- bypasses RLS, so it can still decrypt for participants and run audited
-- admin reveals.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'prep_messages'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.prep_messages', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.prep_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "participant reads own messages" ON public.prep_messages
  FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "participant inserts own messages" ON public.prep_messages
  FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "participant marks own as read" ON public.prep_messages
  FOR UPDATE USING (recipient_id = auth.uid());

-- ── 2. Generic bell notification (no message body) ───────────────────
CREATE OR REPLACE FUNCTION public.prep_notify_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_name TEXT;
BEGIN
  SELECT name INTO v_sender_name FROM public.prep_users WHERE id = NEW.sender_id;
  IF v_sender_name IS NULL THEN v_sender_name := 'Someone'; END IF;

  INSERT INTO public.prep_notifications (user_id, icon, text, action)
  VALUES (
    NEW.recipient_id,
    '💬',
    v_sender_name || ' sent you a message',
    '{"type":"page","page":"messages"}'::jsonb
  );
  RETURN NEW;
END;
$$;

-- ── 3. Private attachment bucket ─────────────────────────────────────
UPDATE storage.buckets SET public = false WHERE id = 'message-attachments';

DROP POLICY IF EXISTS "public read message attachments" ON storage.objects;
DROP POLICY IF EXISTS "authenticated upload message attachments" ON storage.objects;
DROP POLICY IF EXISTS "owner uploads message attachments" ON storage.objects;
DROP POLICY IF EXISTS "owner reads message attachments" ON storage.objects;

-- Uploads: a user may only write into their own <uid>/… folder.
CREATE POLICY "owner uploads message attachments" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'message-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Direct reads: only the uploader (for their own pending-attachment preview).
-- Recipients get a signed URL from the server; the admin dashboard gets none.
CREATE POLICY "owner reads message attachments" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'message-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 4. Break-glass audit log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_message_access_log (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      UUID REFERENCES public.prep_users(id) ON DELETE SET NULL,
  message_id    INTEGER,
  sender_id     UUID,
  recipient_id  UUID,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.prep_message_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin reads message access log" ON public.prep_message_access_log;
CREATE POLICY "admin reads message access log" ON public.prep_message_access_log
  FOR SELECT USING (public.is_admin());
