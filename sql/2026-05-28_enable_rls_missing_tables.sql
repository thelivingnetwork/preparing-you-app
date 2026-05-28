-- ── Enable RLS on tables flagged by Supabase security advisor ──────────────
-- Addresses: rls_disabled_in_public on prep_articles, prep_book_chunks,
--            prep_chapters, prep_paul_chats, prep_signoffs
-- Server uses service_role key (bypasses RLS) — these policies only affect
-- client (anon/authenticated) access.

-- ── prep_articles (topical library — read-only public content) ──────────────
ALTER TABLE public.prep_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "articles: authenticated users can read"
  ON public.prep_articles
  FOR SELECT
  TO authenticated
  USING (true);

-- ── prep_chapters (book chapters — read-only content) ──────────────────────
ALTER TABLE public.prep_chapters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chapters: authenticated users can read"
  ON public.prep_chapters
  FOR SELECT
  TO authenticated
  USING (true);

-- ── prep_book_chunks (RAG corpus — read-only, queried via server RPC) ───────
ALTER TABLE public.prep_book_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "book_chunks: authenticated users can read"
  ON public.prep_book_chunks
  FOR SELECT
  TO authenticated
  USING (true);

-- ── prep_paul_chats (personal AI chat history) ─────────────────────────────
ALTER TABLE public.prep_paul_chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "paul_chats: users can read their own"
  ON public.prep_paul_chats
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "paul_chats: users can insert their own"
  ON public.prep_paul_chats
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ── prep_signoffs (PCM sign-off records — sensitive) ───────────────────────
ALTER TABLE public.prep_signoffs ENABLE ROW LEVEL SECURITY;

-- The prep user can see their own sign-off; their PCM can see it too
CREATE POLICY "signoffs: users and pcms can read relevant rows"
  ON public.prep_signoffs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR pcm_id = auth.uid());

-- Only the prep user creates a sign-off request
CREATE POLICY "signoffs: users can request their own signoff"
  ON public.prep_signoffs
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Only the assigned PCM can update (approve/decline)
CREATE POLICY "signoffs: pcm can update their assigned signoffs"
  ON public.prep_signoffs
  FOR UPDATE
  TO authenticated
  USING (pcm_id = auth.uid());
