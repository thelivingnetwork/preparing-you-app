-- ════════════════════════════════════════════════════════════════════
-- prep_messages: close the direct-insert path left over from May
--
-- Until 2026-05-31 the client wrote messages straight to the table. The
-- 2026-06-03 hardening moved every write through the server (service_role)
-- and column-locked UPDATE to read_at — but the INSERT policy was never
-- withdrawn. A member with the anon key and their own session could still
-- POST /rest/v1/prep_messages directly, which bypasses:
--
--   * the server's rate limit  (30 sends/min per member)
--   * the message length cap   (MAX_MSG_CHARS)
--   * encryption at rest       (encryptBody on the way in)
--   * the is_system recipient check (one-way "Preparing You" threads)
--
-- and would still fire the recipient's notification trigger — i.e. an
-- unthrottled way to spam any member's badge with unencrypted rows.
--
-- The app has not used this path since v0.9.44. Both historical policy
-- names are dropped; the grant is revoked so no future policy can
-- accidentally re-open it.
--
-- ORDER: safe to apply any time — no shipped client depends on it.
-- ════════════════════════════════════════════════════════════════════

begin;

drop policy if exists "participant inserts own messages" on public.prep_messages;
drop policy if exists "user inserts own messages"        on public.prep_messages;

revoke insert on table public.prep_messages from authenticated, anon;

-- prep_room_messages never had a client INSERT policy; make that explicit
-- so it can't be granted by accident later.
revoke insert on table public.prep_room_messages from authenticated, anon;

commit;

-- Verify (as an authenticated member via REST):
--   POST /rest/v1/prep_messages {...}      → 42501 permission denied
--   POST /rest/v1/prep_room_messages {...} → 42501 permission denied
--   Sending from the app itself (server route) → still 200
--
-- Confirm no policy remains:
--   select policyname, cmd from pg_policies
--    where tablename in ('prep_messages','prep_room_messages') order by 1;
