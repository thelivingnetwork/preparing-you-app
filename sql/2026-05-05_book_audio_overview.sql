-- Add audio overview support to prep_books.
-- The Audio Overview is a 10-20 min NotebookLM-generated podcast-style
-- discussion of the source book, served as a static mp3 from /audio/overviews/.
ALTER TABLE public.prep_books
  ADD COLUMN IF NOT EXISTS audio_overview_path TEXT,
  ADD COLUMN IF NOT EXISTS audio_overview_duration_sec INT,
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Seed the five books (idempotent on slug). Update titles/descriptions later.
INSERT INTO public.prep_books (title, slug, order_index, audio_overview_path, description)
VALUES
  ('Book I',   'book-1', 1, '/audio/overviews/1.mp3', NULL),
  ('Book II',  'book-2', 2, '/audio/overviews/2.mp3', NULL),
  ('Book III', 'book-3', 3, '/audio/overviews/3.mp3', NULL),
  ('Book IV',  'book-4', 4, '/audio/overviews/4.mp3', NULL),
  ('Book V',   'book-5', 5, '/audio/overviews/5.mp3', NULL)
ON CONFLICT (slug) DO NOTHING;

-- Allow signed-in users to read the books list.
ALTER TABLE public.prep_books ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "any signed-in reads prep_books" ON public.prep_books;
CREATE POLICY "any signed-in reads prep_books" ON public.prep_books
  FOR SELECT USING (auth.role() = 'authenticated');
