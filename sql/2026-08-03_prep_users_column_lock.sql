-- ════════════════════════════════════════════════════════════════════
-- prep_users: members may edit their profile, not their privileges
--
-- The UPDATE policy has been "id = auth.uid()" since the initial schema —
-- own row only, but EVERY column of it. Several of those columns decide
-- what a member is allowed to do, so a member could grant themselves:
--
--   tln_invited_at   → the Living Network gate. Setting it satisfies the
--                      WITH CHECK on "tln-granted manage own prep_pcms",
--                      so they could then register themselves as a PCM —
--                      receiving elections and private messages from
--                      members under a trusted title, defeating the
--                      invite-only chain entirely. (Worst of the set.)
--   pcm_id           → attach themselves to any minister's flock without
--                      that minister ever accepting.
--   gateway_v1..3_at → skip the three introduction videos that gate PCM
--                      selection (electPcm re-checks these server-side,
--                      but it reads the same forgeable columns).
--   is_system        → masquerade as a one-way "Preparing You" account.
--
-- Same treatment prep_messages got on 2026-06-03: revoke the table-level
-- UPDATE and re-grant an explicit column list. RLS still narrows rows to
-- the member's own; this narrows which columns of it they may write.
-- service_role (the server) bypasses both and is unaffected.
--
-- ORDER MATTERS: deploy app.js v0.9.62+ and server v0.9.62+ FIRST. The
-- older client writes gateway_v*_at directly and clears pcm_id on
-- withdraw; both now go through the server (POST /gateway/complete and
-- POST /pcm/withdraw). Applying this against an older client would make
-- the third video silently fail to record.
-- ════════════════════════════════════════════════════════════════════

begin;

-- Row scope: own row, and it must still be own row afterwards (the original
-- policy had no WITH CHECK at all).
drop policy if exists "user updates own prep_users" on public.prep_users;
create policy "user updates own prep_users" on public.prep_users
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Column scope: the six a member legitimately edits about themselves.
--   name, region, avatar_url  — profile screen
--   timezone                  — set automatically from the browser
--   *_guidelines_accepted_at  — their own consent stamps
-- Everything else (id, email, pcm_id, tln_invited_at, joined_tln_at,
-- gateway_v1_at, gateway_v2_at, gateway_v3_at, gateway_watched_at,
-- is_system, created_at) is server-written only.
revoke update on table public.prep_users from authenticated, anon;
grant update (name, region, avatar_url, timezone,
              guidelines_accepted_at, pcm_guidelines_accepted_at)
  on table public.prep_users to authenticated;

commit;

-- Verify (as an authenticated member via REST):
--   PATCH /rest/v1/prep_users?id=eq.<self> {"name":"x"}            → 200
--   PATCH /rest/v1/prep_users?id=eq.<self> {"tln_invited_at":"…"}  → 42501
--   PATCH /rest/v1/prep_users?id=eq.<self> {"pcm_id":"<uuid>"}     → 42501
--   PATCH /rest/v1/prep_users?id=eq.<self> {"gateway_v1_at":"…"}   → 42501
--   PATCH /rest/v1/prep_users?id=eq.<self> {"is_system":true}      → 42501
--
-- In the app, confirm afterwards:
--   * editing name/region saves
--   * finishing an introduction video still ticks the tile
--   * withdrawing a PCM still clears the pairing
