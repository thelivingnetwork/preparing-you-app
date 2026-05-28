-- ── Auto-create a prep_notifications row on every prep_messages INSERT ─────
-- This guarantees the bell badge and Realtime subscription fire regardless of
-- whether the message came through the server /messages/send endpoint or was
-- inserted directly by the client (e.g. old cached PWA version or video-call
-- invite inserted inline).  The server's /messages/send no longer calls
-- notify() for messages; it only calls pushToUser() for web push.

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
  -- Look up sender's display name
  SELECT name INTO v_sender_name
    FROM public.prep_users
   WHERE id = NEW.sender_id;
  IF v_sender_name IS NULL THEN v_sender_name := 'Someone'; END IF;

  -- Build a short preview (max 60 chars + ellipsis)
  v_preview := left(NEW.body, 60);
  IF length(NEW.body) > 60 THEN v_preview := v_preview || '…'; END IF;

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

-- Drop first in case this migration is re-run
DROP TRIGGER IF EXISTS prep_message_notification ON public.prep_messages;

CREATE TRIGGER prep_message_notification
  AFTER INSERT ON public.prep_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.prep_notify_on_message();
