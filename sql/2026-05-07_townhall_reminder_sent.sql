ALTER TABLE public.prep_townhalls
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
