-- 2026-06-18 — Encrypt Paul chats at rest + break-glass audit log.
--
-- prep_paul_chats.message is now AES-256-GCM encrypted server-side by the
-- backend (encryptBody(), same MESSAGE_ENC_KEY as prep_messages bodies). The
-- server holds the key (it must, to send the conversation to Claude), so an
-- admin CAN decrypt a member's conversation — but only via a deliberate,
-- reason-tagged "break glass" reveal, which is recorded in this table. The
-- reveal endpoint fails closed: if it cannot write the audit row, it refuses
-- to return any plaintext.
--
-- Run this in the Supabase SQL editor for project qvcfgcwecykilbddgqzv BEFORE
-- (or alongside) deploying the server, so the reveal endpoint can log access.

create table if not exists prep_admin_audit (
  id             bigint generated always as identity primary key,
  admin_user_id  uuid not null,
  action         text not null,
  target_user_id uuid,
  reason         text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

-- Service-role only: RLS enabled with NO policies, so only the backend's
-- service-role key can read or write it (matches prep_client_errors).
alter table prep_admin_audit enable row level security;

create index if not exists prep_admin_audit_created_idx on prep_admin_audit (created_at desc);
create index if not exists prep_admin_audit_target_idx  on prep_admin_audit (target_user_id);
