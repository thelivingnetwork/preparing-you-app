-- ════════════════════════════════════════════════════════════════════
-- Server-side notification feed (TLN-style bell, but cross-device)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prep_notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  icon        TEXT,
  text        TEXT NOT NULL,
  action      JSONB,            -- e.g. {"type":"page","page":"pcm"} — optional click target
  created_at  TIMESTAMPTZ DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS prep_notifications_user_idx
  ON public.prep_notifications (user_id, created_at DESC);

ALTER TABLE public.prep_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user reads own notifs" ON public.prep_notifications;
CREATE POLICY "user reads own notifs" ON public.prep_notifications
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "user marks own notifs read" ON public.prep_notifications;
CREATE POLICY "user marks own notifs read" ON public.prep_notifications
  FOR UPDATE USING (user_id = auth.uid());
