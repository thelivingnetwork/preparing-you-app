-- Enable Supabase Realtime on prep_notifications so the client can
-- subscribe to INSERT events and refresh the bell badge instantly
-- instead of waiting for the 30-second poll.
ALTER PUBLICATION supabase_realtime ADD TABLE public.prep_notifications;
