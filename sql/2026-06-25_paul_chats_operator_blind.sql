-- 2026-06-25 — Paul chats: operator-blind by NOT storing conversation content.
--
-- Background: prep_paul_chats.message was encrypted at rest, but the server held the
-- key (MESSAGE_ENC_KEY) and an admin could decrypt a member's whole conversation via an
-- audited "break glass" reveal. We are removing that capability. The server no longer
-- persists Paul message bodies at all — the chat handlers now insert role + timestamp
-- with an empty message (the daily-cap guardrail only needs the row COUNT, never the text;
-- the user never reads their Paul history back). So there is nothing left to reveal.
--
-- This migration purges all EXISTING Paul message content (plaintext or enc:v1: ciphertext)
-- so no historical conversation remains server-decryptable. It is destructive of stored
-- Paul history content by design — that history is not shown to anyone, and removing it is
-- the point of the change. Row count / timestamps are preserved so usage stats are intact.
--
-- The message column keeps its NOT NULL constraint; we store '' (empty), not NULL, which is
-- why the server inserts message: '' rather than null — no schema/constraint change needed,
-- and no ordering dependency between this migration and the Render deploy.

update public.prep_paul_chats
   set message = ''
 where message <> '';

-- Sanity check (optional): expect 0 rows with any remaining content.
-- select count(*) as remaining_with_content from public.prep_paul_chats where message <> '';
