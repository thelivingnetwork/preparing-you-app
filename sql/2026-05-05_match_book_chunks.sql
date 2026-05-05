-- pgvector cosine-similarity retrieval RPC for Paul.
CREATE OR REPLACE FUNCTION public.match_book_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 6
)
RETURNS TABLE (
  id INT,
  book_id INT,
  chapter_id INT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    book_id,
    chapter_id,
    chunk_text,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.prep_book_chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
