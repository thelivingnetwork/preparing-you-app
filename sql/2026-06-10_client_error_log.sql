-- ════════════════════════════════════════════════════════════════════
-- Lightweight error log (self-hosted, no third-party service).
-- Apply to: qvcfgcwecykilbddgqzv  (Preparing You supabase project)
--
-- The client's global error handlers POST to the server's /client-error
-- endpoint, and the server's own request handler logs its 500s here too.
-- All writes go through the server using the service-role key, so the table
-- is locked down: RLS on, NO policies → only the service role can read/write.
-- Query it from the SQL editor to see what's actually failing in production.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prep_client_errors (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now(),
  source      TEXT,            -- 'client' | 'server'
  kind        TEXT,            -- 'error' | 'unhandledrejection' | 'csp' | 'http_500' …
  message     TEXT,
  stack       TEXT,
  url         TEXT,            -- page URL (client) or request path (server)
  user_agent  TEXT,
  app_version TEXT,
  user_uid    TEXT,            -- best-effort; may be null (errors pre-login)
  extra       JSONB
);

CREATE INDEX IF NOT EXISTS prep_client_errors_created_idx
  ON public.prep_client_errors (created_at DESC);

ALTER TABLE public.prep_client_errors ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service-role bypasses RLS; everyone else is denied.

-- Optional housekeeping: drop rows older than 30 days. Run manually or wire a
-- pg_cron job later.
--   DELETE FROM public.prep_client_errors WHERE created_at < now() - interval '30 days';
