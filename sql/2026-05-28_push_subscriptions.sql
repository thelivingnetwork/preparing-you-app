-- ════════════════════════════════════════════════════════════════════
-- Web Push subscriptions — one row per browser/device per user.
-- The server fans out a push to every row when notify() fires.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prep_push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  last_seen   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prep_push_subs_user_idx
  ON public.prep_push_subscriptions (user_id);

-- Service-role writes only (server-side). No RLS policies needed for app code,
-- but enable RLS so anon/authenticated cannot read other users' endpoints.
ALTER TABLE public.prep_push_subscriptions ENABLE ROW LEVEL SECURITY;
