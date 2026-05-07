-- Track live state of the townhall so non-hosts can only join once a
-- moderator has started the call.
ALTER TABLE public.prep_townhalls
  ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
