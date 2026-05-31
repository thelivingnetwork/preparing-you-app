-- ════════════════════════════════════════════════════════════════════
-- Profile photos.
--
-- Lets a member upload a profile picture that becomes their profile icon.
-- Adds prep_users.avatar_url (the public URL of the chosen image) and a
-- public "avatars" Storage bucket. A member may write only inside their own
-- <uid>/ folder; anyone may read (public bucket) so the icon renders without
-- expiring signed URLs.
--
-- No new prep_users policy is needed: members already update their own row
-- (the profile Save flow), and that UPDATE policy covers avatar_url.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.prep_users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ── Public avatars bucket (5 MB cap) ─────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('avatars', 'avatars', true, 5242880)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

-- Owner may upload / replace / delete only within their own <uid>/ folder.
DROP POLICY IF EXISTS "owner uploads avatar" ON storage.objects;
CREATE POLICY "owner uploads avatar" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "owner updates avatar" ON storage.objects;
CREATE POLICY "owner updates avatar" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "owner deletes avatar" ON storage.objects;
CREATE POLICY "owner deletes avatar" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone may read avatars (public bucket).
DROP POLICY IF EXISTS "public read avatars" ON storage.objects;
CREATE POLICY "public read avatars" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');
