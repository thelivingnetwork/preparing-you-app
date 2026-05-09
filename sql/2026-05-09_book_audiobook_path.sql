-- Full-narration audiobook path for prep_books.
-- The Audiobook is the entire book read aloud (separate from the shorter
-- audio_overview) — typically a multi-hour MP3 served as a static asset.
ALTER TABLE public.prep_books
  ADD COLUMN IF NOT EXISTS audiobook_path TEXT,
  ADD COLUMN IF NOT EXISTS audiobook_duration_sec INT;
