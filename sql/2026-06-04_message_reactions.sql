-- ════════════════════════════════════════════════════════════════════
-- Tap-back style reactions for the in-app messenger.
--
-- A single JSONB column on prep_messages holds a map of
--   { "<reactor_user_id>": "<emoji>", ... }
-- i.e. one reaction per user per message (Messenger / iMessage style).
-- For a 1:1 thread that is at most two entries per row.
--
-- All reads/writes go through the server (service role) — clients never
-- touch prep_messages directly — so no new RLS policies are required.
-- The table is already in the supabase_realtime publication with
-- REPLICA IDENTITY FULL (see 2026-06-03_messages_realtime.sql), so the
-- UPDATE that sets a reaction is broadcast to both participants live.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.prep_messages
  ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
