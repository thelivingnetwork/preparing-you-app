-- ════════════════════════════════════════════════════════════════════
-- Per-user "Five Books" audio-overview completion tracking.
-- Used by the onboarding journey: the Join-The-Living-Network stage only
-- unlocks once a user has listened to all five book audio overviews, in
-- order. One row is written when a user finishes a book's audio overview.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prep_book_audio_progress (
  user_id      UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  book_id      INT  NOT NULL REFERENCES public.prep_books(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

CREATE INDEX IF NOT EXISTS prep_book_audio_progress_user_idx
  ON public.prep_book_audio_progress (user_id);

ALTER TABLE public.prep_book_audio_progress ENABLE ROW LEVEL SECURITY;

-- A user may read and write only their own progress rows.
DROP POLICY IF EXISTS "user reads own book audio progress" ON public.prep_book_audio_progress;
CREATE POLICY "user reads own book audio progress" ON public.prep_book_audio_progress
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user writes own book audio progress" ON public.prep_book_audio_progress;
CREATE POLICY "user writes own book audio progress" ON public.prep_book_audio_progress
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Admins (see 2026-05-06_prep_admins.sql) get full read+write so the admin
-- app and the reset tool can see / clear progress.
DROP POLICY IF EXISTS "admin reads all prep_book_audio_progress" ON public.prep_book_audio_progress;
CREATE POLICY "admin reads all prep_book_audio_progress" ON public.prep_book_audio_progress
  FOR SELECT USING (public.is_admin());
DROP POLICY IF EXISTS "admin writes all prep_book_audio_progress" ON public.prep_book_audio_progress;
CREATE POLICY "admin writes all prep_book_audio_progress" ON public.prep_book_audio_progress
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
