-- Enable pg_cron and schedule the room purge job. The room_brainstorm
-- migration wraps cron.schedule in a conditional that no-ops when the
-- extension isn't installed; on this project it wasn't, so this migration
-- installs it and re-runs the schedule.
create extension if not exists pg_cron with schema extensions;

grant usage on schema cron to postgres;
grant all on all tables in schema cron to postgres;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'purge-expired-rooms',
      '*/15 * * * *',
      'select public.purge_expired_rooms();'
    );
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $cron$;
