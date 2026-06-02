-- Per-user "hide conversation" support for the Messages inbox.
-- Swiping a conversation and tapping Delete records a cleared_at for that
-- (user, peer) pair. The inbox then hides that conversation until a NEW
-- message arrives after cleared_at — non-destructive: the messages themselves
-- are never deleted, and the other participant keeps their copy.
--
-- Only the service-role server touches this table, so RLS is enabled with no
-- policies (deny all direct client access).

create table if not exists prep_message_clears (
  user_id    uuid        not null,
  peer_id    uuid        not null,
  cleared_at timestamptz not null default now(),
  primary key (user_id, peer_id)
);

alter table prep_message_clears enable row level security;
