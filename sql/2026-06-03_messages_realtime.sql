-- ════════════════════════════════════════════════════════════════════
-- Real-time message delivery (signal only — message bodies stay encrypted).
--
-- The client subscribes to postgres_changes on prep_messages and uses the
-- event purely as a SIGNAL to immediately re-fetch the DECRYPTED thread/inbox
-- from the server (which alone holds MESSAGE_ENC_KEY). No plaintext ever
-- travels over Realtime — only the participant's own ciphertext + metadata,
-- which they are already entitled to via the existing SELECT policy from
-- 2026-05-31_encrypt_messages.sql:
--
--     CREATE POLICY "participant reads own messages" ON public.prep_messages
--       FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());
--
-- That policy already authorizes Realtime to notify each participant of their
-- own rows, so this migration only turns on streaming + makes UPDATE events
-- carry enough columns for the client's filters to match.
-- ════════════════════════════════════════════════════════════════════

-- 1. Stream prep_messages over the Supabase Realtime publication (idempotent —
--    re-running this migration is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'prep_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.prep_messages';
  END IF;
END $$;

-- 2. Include every column in UPDATE change payloads so the client's
--    `sender_id=eq.<me>` filter matches on read-receipt (read_at) updates and
--    delivers the live "Seen" signal. Default replica identity is the primary
--    key only, which would strip sender_id from the UPDATE event and the
--    client would never be told its message was read in real time. (INSERT
--    events always carry the full new row, so incoming-message delivery does
--    not depend on this — but it is required for the read receipts.)
ALTER TABLE public.prep_messages REPLICA IDENTITY FULL;
