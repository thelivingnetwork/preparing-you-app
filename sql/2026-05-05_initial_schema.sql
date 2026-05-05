-- ════════════════════════════════════════════════════════════════════════
--  Preparing You — initial schema
--  Apply to a NEW Supabase project (separate from The Living Network).
-- ════════════════════════════════════════════════════════════════════════

-- ── prep_users ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  region TEXT,
  gateway_watched_at TIMESTAMPTZ,
  pcm_id UUID REFERENCES public.prep_users(id) ON DELETE SET NULL,
  joined_tln_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_pcms ──────────────────────────────────────────────
-- A PCM is a prep_users row that volunteered. Kept as its own table so
-- contact-channel fields and active flag are explicit.
CREATE TABLE IF NOT EXISTS public.prep_pcms (
  id UUID PRIMARY KEY REFERENCES public.prep_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  telegram TEXT,
  messenger TEXT,
  region TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_books ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  slug TEXT UNIQUE NOT NULL,
  pdf_storage_path TEXT,
  cover_url TEXT,
  order_index INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_chapters ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_chapters (
  id SERIAL PRIMARY KEY,
  book_id INT NOT NULL REFERENCES public.prep_books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  order_index INT DEFAULT 0,
  page_start INT,
  page_end INT,
  audio_storage_path TEXT,
  summary_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_articles (topical library) ────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_articles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body_md TEXT,
  video_url TEXT,
  tags TEXT[] DEFAULT '{}',
  published_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_signoffs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_signoffs (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  pcm_id UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined
  note TEXT,
  requested_at TIMESTAMPTZ DEFAULT now(),
  approved_at TIMESTAMPTZ
);

-- ── prep_paul_chats ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_paul_chats (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.prep_users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── prep_book_chunks (RAG corpus for Paul) ─────────────────
-- Requires the pgvector extension. Run once: CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS public.prep_book_chunks (
  id SERIAL PRIMARY KEY,
  book_id INT REFERENCES public.prep_books(id) ON DELETE CASCADE,
  chapter_id INT REFERENCES public.prep_chapters(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  embedding vector(1536)
);
CREATE INDEX IF NOT EXISTS prep_book_chunks_emb_idx
  ON public.prep_book_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Trigger: on auth.users insert, create a prep_users row ─
CREATE OR REPLACE FUNCTION public.handle_new_prep_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.prep_users (id, name, email, region)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'region', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_prep ON auth.users;
CREATE TRIGGER on_auth_user_created_prep
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_prep_user();

-- ── RLS (basic — refine later) ─────────────────────────────
ALTER TABLE public.prep_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user reads own prep_users" ON public.prep_users
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "user updates own prep_users" ON public.prep_users
  FOR UPDATE USING (id = auth.uid());
-- prep_pcms readable to all signed-in users (so they can choose one)
ALTER TABLE public.prep_pcms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "any signed-in reads prep_pcms" ON public.prep_pcms
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "user inserts/updates own prep_pcms" ON public.prep_pcms
  FOR ALL USING (id = auth.uid()) WITH CHECK (id = auth.uid());
