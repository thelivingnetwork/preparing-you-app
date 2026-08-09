-- Email subscribers: people who gave an address for the free book on the
-- landing page but have not (yet) created an account in the app.
--
-- Apply in the Preparing You project (qvcfgcwecykilbddgqzv) SQL editor.
-- Pairs with: server /subscribe + /unsubscribe + /admin/subscriber-broadcast,
-- and the admin app's Subscribers page.
--
-- DESIGN NOTE — conversion is COMPUTED, never stored.
-- There is deliberately no `converted_at` column and nothing hooked into the
-- signup path. A subscriber is "still a subscriber" only while no account
-- exists with their address; the admin view derives that with a NOT EXISTS
-- against prep_users. That means the list can never drift out of sync with
-- reality, needs no backfill, and self-heals if a write is ever missed.

begin;

create table if not exists public.prep_subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  -- normalised form: the uniqueness and the prep_users match both key off this,
  -- so Mark@X.com and mark@x.com are one person.
  email_key       text generated always as (lower(btrim(email))) stored,
  source          text not null default 'landing',
  -- per-subscriber secret for one-click unsubscribe links in outgoing email
  token           text not null default encode(gen_random_bytes(16), 'hex'),
  created_at      timestamptz not null default now(),
  last_sent_at    timestamptz,
  unsubscribed_at timestamptz
);

create unique index if not exists prep_subscribers_email_key_uq
  on public.prep_subscribers (email_key);
create unique index if not exists prep_subscribers_token_uq
  on public.prep_subscribers (token);

-- RLS on with NO policies: reachable only via the service role (the server),
-- the same posture as prep_client_errors. The anon key can neither read the
-- list nor add to it — signups go through the server's /subscribe endpoint.
alter table public.prep_subscribers enable row level security;

-- ── Admin read path ───────────────────────────────────────────────────────
-- The admin app queries Supabase as `authenticated`, not the service role, so
-- it cannot read the table directly. Same SECURITY DEFINER view pattern as
-- prep_users_admin: postgres-owned, returns zero rows to non-admins.
create or replace view public.prep_subscribers_admin as
  select s.id, s.email, s.source, s.created_at, s.last_sent_at
  from public.prep_subscribers s
  where exists (select 1 from public.prep_admins a where a.user_id = auth.uid())
    and s.unsubscribed_at is null
    and not exists (
      select 1 from public.prep_users u
      where lower(btrim(u.email)) = s.email_key
    );

alter view public.prep_subscribers_admin owner to postgres;

revoke all on public.prep_subscribers_admin from anon, authenticated;
grant select on public.prep_subscribers_admin to authenticated;

commit;

-- Verify (as yourself in the SQL editor you are postgres, so the view returns
-- rows only if your own uid is in prep_admins — simulate a real admin JWT):
--   begin;
--     select set_config('request.jwt.claims',
--       '{"sub":"<an-admin-uid>","role":"authenticated"}', true);
--     set local role authenticated;
--     select count(*) from public.prep_subscribers_admin;   -- should work
--   rollback;
-- And confirm a non-admin sees nothing:
--   begin;
--     select set_config('request.jwt.claims',
--       '{"sub":"<a-member-uid>","role":"authenticated"}', true);
--     set local role authenticated;
--     select count(*) from public.prep_subscribers_admin;   -- must be 0
--   rollback;
