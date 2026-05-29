-- ════════════════════════════════════════════════════════════════════
-- Admin broadcasts — a one-way announcement from an admin to the entire
-- user base. Delivery is via prep_notifications (bell) + web-push; this
-- table is the audit log / history of what was sent.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prep_broadcasts (
  id              BIGSERIAL PRIMARY KEY,
  sender_id       UUID REFERENCES public.prep_users(id) ON DELETE SET NULL,
  icon            TEXT,
  text            TEXT NOT NULL,
  recipient_count INT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prep_broadcasts_created_idx
  ON public.prep_broadcasts (created_at DESC);

ALTER TABLE public.prep_broadcasts ENABLE ROW LEVEL SECURITY;

-- Admins manage broadcasts (the server writes via service role; these policies
-- let the admin app read the history and, if ever needed, write directly).
DROP POLICY IF EXISTS "admin reads all prep_broadcasts" ON public.prep_broadcasts;
CREATE POLICY "admin reads all prep_broadcasts" ON public.prep_broadcasts
  FOR SELECT USING (public.is_admin());
DROP POLICY IF EXISTS "admin writes all prep_broadcasts" ON public.prep_broadcasts;
CREATE POLICY "admin writes all prep_broadcasts" ON public.prep_broadcasts
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
