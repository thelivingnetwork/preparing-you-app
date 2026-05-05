-- Track sequential gateway video completion per user.
-- Three videos must be watched in order: Contracts, The Snare, The True.
ALTER TABLE public.prep_users
  ADD COLUMN IF NOT EXISTS gateway_v1_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gateway_v2_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gateway_v3_at TIMESTAMPTZ;
