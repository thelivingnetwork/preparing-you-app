-- Add fail_count to prep_push_subscriptions so the server can use
-- a 3-strike rule before pruning, avoiding over-eager removal of iOS
-- subscriptions that transiently return 410 after a service worker update.
ALTER TABLE public.prep_push_subscriptions
  ADD COLUMN IF NOT EXISTS fail_count INT NOT NULL DEFAULT 0;
