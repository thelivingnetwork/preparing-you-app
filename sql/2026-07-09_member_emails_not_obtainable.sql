-- Member emails must not be OBTAINABLE by other members via the REST API
-- (2026-07-09). The client (v after 0.9.54 deploy) no longer selects these
-- columns; notification emails are all sent server-side (service role).
--
-- ORDER MATTERS: deploy the client/server first, then apply this. A client
-- still doing select('*') on these tables would start erroring afterwards.
--
-- Postgres column-level privileges: a table-level SELECT grant covers all
-- columns, so we revoke the table grant and re-grant an explicit column list
-- (everything except email on prep_users; no contact columns on prep_pcms).
-- RLS policies still apply on top — this narrows columns, RLS narrows rows.

begin;

revoke select on table public.prep_users from anon, authenticated;
grant select (id, name, region, avatar_url, pcm_id, tln_invited_at,
              joined_tln_at, guidelines_accepted_at, pcm_guidelines_accepted_at,
              gateway_v1_at, gateway_v2_at, gateway_v3_at, gateway_watched_at,
              timezone, is_system, created_at)
  on table public.prep_users to authenticated;

revoke select on table public.prep_pcms from anon, authenticated;
grant select (id, name, region, active, is_seed, created_at)
  on table public.prep_pcms to authenticated;

commit;

-- Verify (as authenticated via REST):
--   GET /rest/v1/prep_users?select=email       → 42501 permission denied
--   GET /rest/v1/prep_pcms?select=email        → 42501 permission denied
--   GET /rest/v1/prep_users?select=id,name     → 200
--   GET /rest/v1/prep_pcms?select=id,name,region,active → 200
