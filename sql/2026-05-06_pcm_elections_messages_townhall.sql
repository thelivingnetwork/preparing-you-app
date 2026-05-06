-- ════════════════════════════════════════════════════════════════════
-- PCM elections, direct messaging, weekly townhall
-- ════════════════════════════════════════════════════════════════════

-- ── prep_pcm_elections ─────────────────────────────────────
-- One row per election attempt. A user has at most one election in
-- 'pending' or 'accepted' state at a time (enforced by partial unique idx).
CREATE TABLE IF NOT EXISTS public.prep_pcm_elections (
  id           SERIAL PRIMARY KEY,
  elector_id   UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  pcm_id       UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined
  elected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS prep_pcm_elections_one_active_per_elector
  ON public.prep_pcm_elections (elector_id)
  WHERE status IN ('pending','accepted');

CREATE INDEX IF NOT EXISTS prep_pcm_elections_pcm_pending_idx
  ON public.prep_pcm_elections (pcm_id) WHERE status = 'pending';

ALTER TABLE public.prep_pcm_elections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "elector reads own elections" ON public.prep_pcm_elections;
CREATE POLICY "elector reads own elections" ON public.prep_pcm_elections
  FOR SELECT USING (elector_id = auth.uid() OR pcm_id = auth.uid());

-- ── prep_messages ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_messages (
  id            SERIAL PRIMARY KEY,
  sender_id     UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  read_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS prep_messages_recipient_idx
  ON public.prep_messages (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prep_messages_thread_idx
  ON public.prep_messages (sender_id, recipient_id, created_at);

ALTER TABLE public.prep_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user reads own messages" ON public.prep_messages;
CREATE POLICY "user reads own messages" ON public.prep_messages
  FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());

-- ── prep_townhalls ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_townhalls (
  id            SERIAL PRIMARY KEY,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  title         TEXT,
  topic         TEXT,
  daily_room    TEXT,           -- the Daily.co room name (not full URL)
  recording_url TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.prep_townhalls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "any signed-in reads townhalls" ON public.prep_townhalls;
CREATE POLICY "any signed-in reads townhalls" ON public.prep_townhalls
  FOR SELECT USING (auth.role() = 'authenticated');

-- ── prep_townhall_hosts ────────────────────────────────────
-- A user is a townhall host if their auth.uid is in this table. Hosts
-- get a moderator token from the server when joining the room.
CREATE TABLE IF NOT EXISTS public.prep_townhall_hosts (
  user_id    UUID PRIMARY KEY REFERENCES public.prep_users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.prep_townhall_hosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "any signed-in reads townhall hosts" ON public.prep_townhall_hosts;
CREATE POLICY "any signed-in reads townhall hosts" ON public.prep_townhall_hosts
  FOR SELECT USING (auth.role() = 'authenticated');

-- Seed one recurring weekly townhall: Sundays 7 PM Pacific (PST = UTC-8).
-- 7 PM PST = 03:00 UTC the next day.
-- We'll seed the next upcoming Sunday after today.
DO $$
DECLARE
  next_sunday DATE := (CURRENT_DATE + ((7 - EXTRACT(DOW FROM CURRENT_DATE)::INT) % 7) * INTERVAL '1 day')::DATE;
  th_at TIMESTAMPTZ := (next_sunday + INTERVAL '1 day' + INTERVAL '3 hours');  -- 03:00 UTC Mon = 19:00 PST Sun
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.prep_townhalls) THEN
    INSERT INTO public.prep_townhalls (scheduled_at, title, topic, daily_room)
    VALUES (th_at, 'Weekly Townhall', 'Open discussion', 'preparing-you-townhall');
  END IF;
END $$;
