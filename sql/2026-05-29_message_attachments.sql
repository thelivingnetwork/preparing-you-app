-- ════════════════════════════════════════════════════════════
-- Message attachments
-- Adds attachment columns to prep_messages and a public Storage
-- bucket ("message-attachments") that authenticated users can
-- upload to. Images are previewed inline in the chat; other files
-- (PDFs/docs) render as downloadable links.
-- ════════════════════════════════════════════════════════════

-- ── prep_messages columns ──────────────────────────────────
ALTER TABLE public.prep_messages
  ADD COLUMN IF NOT EXISTS attachment_url  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type TEXT;  -- MIME type, e.g. image/png

-- A message used to require a body. Now a message may be body-only,
-- attachment-only, or both — so body becomes nullable but we keep a
-- guard so a message is never completely empty.
ALTER TABLE public.prep_messages ALTER COLUMN body DROP NOT NULL;

ALTER TABLE public.prep_messages DROP CONSTRAINT IF EXISTS prep_messages_body_or_attachment;
ALTER TABLE public.prep_messages ADD CONSTRAINT prep_messages_body_or_attachment
  CHECK (
    (body IS NOT NULL AND length(btrim(body)) > 0)
    OR attachment_url IS NOT NULL
  );

-- ── Storage bucket ─────────────────────────────────────────
-- Public-read bucket (same model as book PDFs/audio). 25 MB cap.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('message-attachments', 'message-attachments', true, 26214400)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

-- Authenticated users may upload; anyone may read (public bucket).
DROP POLICY IF EXISTS "authenticated upload message attachments" ON storage.objects;
CREATE POLICY "authenticated upload message attachments" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'message-attachments');

DROP POLICY IF EXISTS "public read message attachments" ON storage.objects;
CREATE POLICY "public read message attachments" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'message-attachments');

-- ── Notification trigger: handle attachment-only messages ──
-- The body can now be NULL (attachment-only). Without this, the preview
-- string would concatenate to NULL. Fall back to a "📎 <name>" preview.
CREATE OR REPLACE FUNCTION public.prep_notify_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_name TEXT;
  v_preview     TEXT;
BEGIN
  SELECT name INTO v_sender_name
    FROM public.prep_users
   WHERE id = NEW.sender_id;
  IF v_sender_name IS NULL THEN v_sender_name := 'Someone'; END IF;

  IF NEW.body IS NULL OR length(btrim(NEW.body)) = 0 THEN
    -- Attachment-only message
    v_preview := '📎 ' || COALESCE(NEW.attachment_name, 'Attachment');
  ELSE
    v_preview := left(NEW.body, 60);
    IF length(NEW.body) > 60 THEN v_preview := v_preview || '…'; END IF;
  END IF;

  INSERT INTO public.prep_notifications (user_id, icon, text, action)
  VALUES (
    NEW.recipient_id,
    '💬',
    v_sender_name || ': ' || v_preview,
    '{"type":"page","page":"messages"}'::jsonb
  );

  RETURN NEW;
END;
$$;
