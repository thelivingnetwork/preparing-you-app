-- ════════════════════════════════════════════════════════════════════
-- Durable townhall scheduler — pg_cron heartbeat.
-- Apply to: qvcfgcwecykilbddgqzv  (Preparing You supabase project)
--
-- The server runs all five townhall jobs in one idempotent runCronTick().
-- An in-process timer fires it every minute while the server is up; THIS adds
-- the durable layer: pg_cron lives in the database, so it keeps firing the tick
-- even if the in-process timer dies, the server restarts, or (on a future
-- scale-to-zero plan) the server is asleep and needs waking.
--
-- The /cron/tick endpoint is guarded by a shared secret. Set the SAME value as
-- CRON_SECRET in the Render dashboard (env var) AND in the x-cron-secret header
-- below. Run this file's schedule statement in the SQL editor with the real
-- secret substituted — do NOT commit the real value.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every minute, POST the heartbeat to the server.
-- Replace <CRON_SECRET> with the value also set as CRON_SECRET on Render.
select cron.schedule(
  'townhall-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://preparing-you-server.onrender.com/cron/tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

-- Inspect / manage:
--   select jobid, schedule, command, active from cron.job where jobname = 'townhall-tick';
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='townhall-tick') order by start_time desc limit 10;
--   select cron.unschedule('townhall-tick');
