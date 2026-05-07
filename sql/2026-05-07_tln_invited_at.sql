-- Track when a user has been invited to The Living Network so we don't
-- send duplicate invitations from /tln/invite or auto-PCM-grant.
ALTER TABLE public.prep_users
  ADD COLUMN IF NOT EXISTS tln_invited_at TIMESTAMPTZ;
