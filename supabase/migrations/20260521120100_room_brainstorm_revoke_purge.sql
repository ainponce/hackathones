-- Revoke EXECUTE on purge_expired_rooms() from anon and authenticated.
-- The function only needs to run under the cron job (postgres role) and
-- under service_role for ops/debugging. Exposing it via the PostgREST RPC
-- surface would let any anon visitor delete every active room, since the
-- SECURITY DEFINER bypass on RLS means the function runs with full
-- privileges regardless of caller.
--
-- The advisor flagged this after the initial room_brainstorm migration:
-- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
revoke execute on function public.purge_expired_rooms() from anon, authenticated, public;
