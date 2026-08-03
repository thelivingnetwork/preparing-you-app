-- ════════════════════════════════════════════════════════════════════
-- prep_pcm_elections: an elector may withdraw, not self-accept
--
-- Found while tracing the prep_users lockdown — not in the original list.
--
-- "user updates own elections" (2026-05-06) is FOR UPDATE USING
-- (elector_id = auth.uid()) with no WITH CHECK and no column restriction,
-- so an elector can write any value into their own election row —
-- including status = 'accepted' on an election the minister has not
-- answered. That fabricates a pairing the minister never agreed to.
--
-- The impact is smaller than it first looks: message access is keyed on
-- sender/recipient, not on election status, and pcm_id is server-written
-- as of 2026-08-03_prep_users_column_lock.sql — so a self-accept shows a
-- false pairing in the member's own UI and in the PCM's pending list
-- rather than unlocking anything. Still worth closing: the app's only
-- legitimate client-side write here is the withdraw fallback in
-- changePcm(), used when the server is unreachable.
--
-- ORDER: safe to apply any time — withdrawal is all the shipped client does.
-- ════════════════════════════════════════════════════════════════════

begin;

drop policy if exists "user updates own elections" on public.prep_pcm_elections;
create policy "elector withdraws own election" on public.prep_pcm_elections
  for update
  using (elector_id = auth.uid())
  with check (elector_id = auth.uid() and status = 'withdrawn');

commit;

-- Verify (as an authenticated member with a pending election via REST):
--   PATCH /rest/v1/prep_pcm_elections?elector_id=eq.<self>
--         {"status":"withdrawn"}  → 200
--   PATCH … {"status":"accepted"} → 42501 / 0 rows (WITH CHECK violation)
--
-- The minister accepting or declining still works: that path is
-- POST /election/respond on the server, which runs as service_role.
