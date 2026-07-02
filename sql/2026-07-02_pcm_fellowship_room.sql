-- ════════════════════════════════════════════════════════════════════
-- PCM Fellowship — one shared group chat room for all active PCMs.
--
-- prep_messages is strictly two-party (sender_id/recipient_id NOT NULL,
-- per-row read_at, per-pair E2EE), none of which survives N readers — so
-- group messages live in their own table with a per-user read cursor.
-- Bodies use the same server-side at-rest encryption as legacy DMs
-- (encryptBody/MESSAGE_ENC_KEY); group E2EE isn't possible with the
-- current per-peer key scheme.
--
-- All reads/writes go through the server (service role). The client-side
-- SELECT policies exist for two things only: Realtime delivery of the
-- "a row changed" signal (ciphertext + metadata, same model as
-- 2026-06-03_messages_realtime.sql) and the unread nav badge count.
-- ════════════════════════════════════════════════════════════════════

-- ── prep_room_messages ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_room_messages (
  id              SERIAL PRIMARY KEY,
  room_id         TEXT NOT NULL,
  sender_id       UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  body            TEXT,
  reactions       JSONB NOT NULL DEFAULT '{}'::jsonb,
  attachment_url  TEXT,
  attachment_name TEXT,
  attachment_type TEXT,  -- MIME type, e.g. image/png
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prep_room_messages_body_or_attachment CHECK (
    (body IS NOT NULL AND length(btrim(body)) > 0)
    OR attachment_url IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS prep_room_messages_room_idx
  ON public.prep_room_messages (room_id, created_at DESC);

ALTER TABLE public.prep_room_messages ENABLE ROW LEVEL SECURITY;

-- Active PCMs may read the fellowship room (authorizes Realtime delivery
-- and the badge count; bodies are ciphertext, decrypted only by the server).
-- prep_pcms is readable by any signed-in user, so the subquery passes RLS.
DROP POLICY IF EXISTS "active PCMs read fellowship room" ON public.prep_room_messages;
CREATE POLICY "active PCMs read fellowship room" ON public.prep_room_messages
  FOR SELECT USING (
    room_id = 'pcm_fellowship'
    AND EXISTS (
      SELECT 1 FROM public.prep_pcms p
      WHERE p.id = auth.uid() AND p.active
    )
  );
-- No INSERT/UPDATE/DELETE policies: writes go through the server only.

-- ── prep_room_reads ────────────────────────────────────────
-- Per-user "seen up to" cursor per room. The server bumps it whenever the
-- user fetches the room thread; unread = messages newer than the cursor
-- that the user didn't send.
CREATE TABLE IF NOT EXISTS public.prep_room_reads (
  user_id      UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  room_id      TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id)
);

ALTER TABLE public.prep_room_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user reads own room cursor" ON public.prep_room_reads;
CREATE POLICY "user reads own room cursor" ON public.prep_room_reads
  FOR SELECT USING (user_id = auth.uid());
-- Writes go through the server only.

-- ── Realtime ───────────────────────────────────────────────
-- Stream the room over the supabase_realtime publication (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'prep_room_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.prep_room_messages';
  END IF;
END $$;
