-- ════════════════════════════════════════════════════════════════════
-- "Seed PCM" flag.
--
-- A seed PCM is an existing Personal Contact Minister who should survive the
-- "clear the deck" reset (POST /admin/reset-journey) WITHOUT being an admin.
-- They keep their PCM registration and progress so they can keep bootstrapping
-- the multiplication chain after everyone else is reset to a fresh start.
--
-- Admins are already exempt from the reset; this lets non-admins be exempt too.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.prep_pcms
  ADD COLUMN IF NOT EXISTS is_seed BOOLEAN DEFAULT false;
