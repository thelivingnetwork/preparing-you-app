-- ════════════════════════════════════════════════════════════════════
-- Password-locked end-to-end encryption for private messages.
--
-- Model: each member has an ECDH P-256 identity keypair generated on-device.
--   • The PUBLIC key is published to prep_public_keys (world-readable to
--     signed-in members — public keys are meant to be public).
--   • The PRIVATE key is wrapped with a key derived from the member's LOGIN
--     PASSWORD (PBKDF2-SHA256) and only that unreadable blob is stored in
--     prep_key_backups. The server never sees the password or the raw key, so
--     it cannot decrypt messages. The blob lets a member restore history on a
--     new / iOS-evicted device just by logging in (no extra passphrase).
--
-- Messages sent after cutover carry e2ee = true and a client-encrypted body
-- (base64 of iv || AES-256-GCM ciphertext). Legacy rows keep e2ee = false and
-- remain server-decryptable so old conversations don't break.
-- ════════════════════════════════════════════════════════════════════

-- ── Public-key directory ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prep_public_keys (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key text NOT NULL,          -- exported JWK (JSON string)
  alg        text NOT NULL DEFAULT 'ECDH-P256',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.prep_public_keys ENABLE ROW LEVEL SECURITY;

-- Anyone signed in may read any public key (needed to encrypt TO that member).
DROP POLICY IF EXISTS "signed-in reads public keys" ON public.prep_public_keys;
CREATE POLICY "signed-in reads public keys" ON public.prep_public_keys
  FOR SELECT USING (auth.role() = 'authenticated');

-- A member may publish / rotate only their OWN public key.
DROP POLICY IF EXISTS "member writes own public key" ON public.prep_public_keys;
CREATE POLICY "member writes own public key" ON public.prep_public_keys
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "member updates own public key" ON public.prep_public_keys;
CREATE POLICY "member updates own public key" ON public.prep_public_keys
  FOR UPDATE USING (user_id = auth.uid());

-- ── Password-locked private-key backup (owner-only) ─────────────────
CREATE TABLE IF NOT EXISTS public.prep_key_backups (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_private_key text NOT NULL,  -- base64(iv || AES-GCM(private JWK))
  kdf_salt            text NOT NULL,  -- base64 PBKDF2 salt
  kdf_iterations      int  NOT NULL DEFAULT 310000,
  wrap_iv             text NOT NULL,  -- base64 AES-GCM IV for the wrap
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.prep_key_backups ENABLE ROW LEVEL SECURITY;

-- The wrapped blob is unreadable without the password, but it is still ONLY
-- ever exposed to its owner. No one else (including other members) can read it.
DROP POLICY IF EXISTS "member reads own key backup" ON public.prep_key_backups;
CREATE POLICY "member reads own key backup" ON public.prep_key_backups
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "member inserts own key backup" ON public.prep_key_backups;
CREATE POLICY "member inserts own key backup" ON public.prep_key_backups
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "member updates own key backup" ON public.prep_key_backups;
CREATE POLICY "member updates own key backup" ON public.prep_key_backups
  FOR UPDATE USING (user_id = auth.uid());

-- ── Flag client-encrypted messages ─────────────────────────────────
-- e2ee = true  → body is client ciphertext; server stores/returns it as-is.
-- e2ee = false → legacy server-side encryption; server decrypts on read.
ALTER TABLE public.prep_messages
  ADD COLUMN IF NOT EXISTS e2ee boolean NOT NULL DEFAULT false;
