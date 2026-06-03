-- ── System sender ("Preparing You") for one-way admin → member messages ──
-- The admin Broadcast now drops a real message into each member's Messages
-- inbox, sent from a dedicated non-human account so it shows a friendly name
-- and can't be replied to (the member app hides the compose box for it). The
-- server provisions the auth account on demand via the Admin API, so there's
-- no manual user-creation step. This migration only:
--   1. adds the is_system flag used to mark that account and to hide it from
--      every member-facing / admin-facing user list, and
--   2. teaches the existing auth-insert trigger to carry that flag through from
--      user metadata so the account lands flagged the moment it's created.

ALTER TABLE public.prep_users
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.handle_new_prep_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.prep_users (id, name, email, region, is_system)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'region', ''),
    COALESCE((NEW.raw_user_meta_data->>'system')::boolean, false)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- The trigger binding itself is unchanged (CREATE OR REPLACE keeps it wired);
-- re-creating defensively in case this runs on a fresh DB.
DROP TRIGGER IF EXISTS on_auth_user_created_prep ON auth.users;
CREATE TRIGGER on_auth_user_created_prep
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_prep_user();
