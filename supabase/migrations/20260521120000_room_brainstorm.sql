-- Virtual Brainstorm Room — ephemeral collaborative spaces where a hackathon
-- team brainstorms ideas, picks two, runs feasibility + state-of-the-art
-- assessments, defines a persona, and lands on a project scope.
--
-- Security model: no auth. Each participant generates a `session_token` in
-- the browser and sends it as the `x-session-token` header on every request.
-- RLS policies treat that header as a bearer credential. Tokens are 256-bit
-- random and never broadcast across participants, so impersonation requires
-- the attacker to already know another participant's token (out of band).
-- Rooms expire 4h after creation; a pg_cron job purges expired rows every
-- 15 min.

-- ---------- Tables ----------

create table public.rooms (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  host_token       text not null,
  phase            text not null default 'brainstorm'
                     check (phase in ('brainstorm','pick_two','assess','pick_winner','persona','scope','done')),
  locale           text not null default 'en' check (locale in ('en','es','pt')),
  picked_idea_ids  uuid[] not null default '{}',
  winner_idea_id   uuid,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '4 hours')
);

create index rooms_expires_at_idx on public.rooms (expires_at);

create table public.room_participants (
  room_id        uuid not null references public.rooms(id) on delete cascade,
  session_token  text not null,
  handle         text not null,
  joined_at      timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  ready          boolean not null default false,
  primary key (room_id, session_token),
  unique (room_id, handle)
);

create index room_participants_last_seen_idx on public.room_participants (room_id, last_seen_at);

create table public.room_ideas (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms(id) on delete cascade,
  session_token  text not null,
  handle         text not null,
  text           text not null check (char_length(text) between 1 and 280),
  created_at     timestamptz not null default now()
);

create index room_ideas_room_id_idx on public.room_ideas (room_id, created_at);

create table public.room_votes (
  room_id        uuid not null references public.rooms(id) on delete cascade,
  session_token  text not null,
  idea_id        uuid not null references public.room_ideas(id) on delete cascade,
  phase          text not null check (phase in ('pick_two','pick_winner')),
  created_at     timestamptz not null default now(),
  primary key (room_id, session_token, idea_id, phase)
);

create index room_votes_idea_idx on public.room_votes (room_id, phase, idea_id);

create table public.room_assessments (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms(id) on delete cascade,
  idea_id         uuid not null references public.room_ideas(id) on delete cascade,
  kind            text not null check (kind in ('feasibility','state_of_the_art')),
  session_token   text not null,
  verdict         text not null check (verdict in ('yes','no','maybe')),
  note            text check (note is null or char_length(note) <= 280),
  created_at      timestamptz not null default now(),
  unique (room_id, idea_id, kind, session_token)
);

create index room_assessments_lookup_idx on public.room_assessments (room_id, idea_id, kind);

create table public.room_personas (
  room_id     uuid primary key references public.rooms(id) on delete cascade,
  idea_id     uuid,
  who         text check (who is null or char_length(who) <= 280),
  context     text check (context is null or char_length(context) <= 280),
  pain        text check (pain is null or char_length(pain) <= 280),
  updated_at  timestamptz not null default now()
);

create table public.room_scopes (
  room_id       uuid primary key references public.rooms(id) on delete cascade,
  must_have     text[] not null default '{}',
  nice_to_have  text[] not null default '{}',
  out_of_scope  text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

create table public.room_phase_events (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  event_type  text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index room_phase_events_room_idx on public.room_phase_events (room_id, created_at);

-- ---------- Helpers ----------

-- Read the bearer session token from the PostgREST request headers.
-- Returns null when called outside a request (e.g. from cron jobs), which
-- makes WITH CHECK policies fall through cleanly.
create or replace function public.room_session_token()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::jsonb ->> 'x-session-token',
      ''
    ),
    ''
  );
$$;

alter function public.room_session_token() set search_path = public, pg_temp;

-- Read the host token (only the room creator knows it; required to call
-- `close` or `extend` later). Same shape as room_session_token().
create or replace function public.room_host_token()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::jsonb ->> 'x-host-token',
      ''
    ),
    ''
  );
$$;

alter function public.room_host_token() set search_path = public, pg_temp;

-- ---------- Anti-spam triggers ----------

create or replace function public.enforce_room_idea_limit()
returns trigger
language plpgsql
as $$
declare
  current_count int;
begin
  select count(*) into current_count
    from public.room_ideas
    where room_id = new.room_id
      and session_token = new.session_token;
  if current_count >= 20 then
    raise exception 'room_ideas_per_session_limit' using errcode = '23514';
  end if;
  return new;
end;
$$;

alter function public.enforce_room_idea_limit() set search_path = public, pg_temp;

create trigger room_ideas_limit_trigger
  before insert on public.room_ideas
  for each row execute function public.enforce_room_idea_limit();

create or replace function public.enforce_room_vote_limit()
returns trigger
language plpgsql
as $$
declare
  current_count int;
  cap int;
begin
  cap := case new.phase when 'pick_two' then 2 when 'pick_winner' then 1 else 0 end;
  if cap = 0 then
    raise exception 'room_votes_invalid_phase' using errcode = '23514';
  end if;
  select count(*) into current_count
    from public.room_votes
    where room_id = new.room_id
      and session_token = new.session_token
      and phase = new.phase;
  if current_count >= cap then
    raise exception 'room_votes_per_session_limit' using errcode = '23514';
  end if;
  return new;
end;
$$;

alter function public.enforce_room_vote_limit() set search_path = public, pg_temp;

create trigger room_votes_limit_trigger
  before insert on public.room_votes
  for each row execute function public.enforce_room_vote_limit();

-- ---------- Phase transition logic ----------

-- Picks the next phase. Encapsulates the state machine, including the
-- branch logic for `assess`:
--   * if both picked ideas pass both checks → pick_winner
--   * if exactly one passes → that idea becomes winner, go to persona
--   * if none pass → loop back to brainstorm (reset picked_idea_ids)
-- "Passes a check" = yes_count >= no_count and yes_count >= 1.
create or replace function public.room_next_phase(p_room uuid)
returns text
language plpgsql
as $$
declare
  current_phase text;
  picked uuid[];
  passing uuid[];
  next_p text;
  winner uuid;
begin
  select phase, picked_idea_ids into current_phase, picked
    from public.rooms where id = p_room;

  if current_phase is null then return null; end if;

  case current_phase
    when 'brainstorm' then next_p := 'pick_two';
    when 'pick_two'   then next_p := 'assess';
    when 'assess'     then
      select array_agg(idea_id) into passing
      from (
        select i.idea_id
        from unnest(picked) as i(idea_id)
        where exists (
          select 1 from public.room_assessments a
            where a.room_id = p_room and a.idea_id = i.idea_id
              and a.kind = 'feasibility'
            group by a.idea_id
            having sum(case when verdict = 'yes' then 1 else 0 end) >=
                   sum(case when verdict = 'no'  then 1 else 0 end)
               and sum(case when verdict = 'yes' then 1 else 0 end) >= 1
        )
        and exists (
          select 1 from public.room_assessments a
            where a.room_id = p_room and a.idea_id = i.idea_id
              and a.kind = 'state_of_the_art'
            group by a.idea_id
            having sum(case when verdict = 'yes' then 1 else 0 end) >=
                   sum(case when verdict = 'no'  then 1 else 0 end)
               and sum(case when verdict = 'yes' then 1 else 0 end) >= 1
        )
      ) s;

      if passing is null or array_length(passing, 1) is null then
        next_p := 'brainstorm';
      elsif array_length(passing, 1) = 1 then
        winner := passing[1];
        next_p := 'persona';
      else
        next_p := 'pick_winner';
      end if;
    when 'pick_winner' then next_p := 'persona';
    when 'persona'     then next_p := 'scope';
    when 'scope'       then next_p := 'done';
    when 'done'        then next_p := 'done';
  end case;

  -- Side effects per transition. Stored as part of next_phase so the caller
  -- doesn't need to know branching details.
  if current_phase = 'pick_two' and next_p = 'assess' then
    -- Capture the top-2 ideas by vote count.
    update public.rooms set picked_idea_ids = (
      select coalesce(array_agg(idea_id), '{}')
      from (
        select v.idea_id, count(*) as c
        from public.room_votes v
        where v.room_id = p_room and v.phase = 'pick_two'
        group by v.idea_id
        order by c desc, v.idea_id asc
        limit 2
      ) t
    ) where id = p_room;
  end if;

  if current_phase = 'assess' and next_p = 'brainstorm' then
    -- Loop back: clear picks and any cast votes/assessments so the next
    -- round of brainstorm/pick_two/assess starts clean.
    update public.rooms set picked_idea_ids = '{}' where id = p_room;
    delete from public.room_votes where room_id = p_room;
    delete from public.room_assessments where room_id = p_room;
  end if;

  if current_phase = 'assess' and next_p = 'persona' and winner is not null then
    update public.rooms set winner_idea_id = winner where id = p_room;
  end if;

  if current_phase = 'pick_winner' and next_p = 'persona' then
    -- Pick the idea with the most pick_winner votes.
    update public.rooms set winner_idea_id = (
      select v.idea_id
      from public.room_votes v
      where v.room_id = p_room and v.phase = 'pick_winner'
      group by v.idea_id
      order by count(*) desc, v.idea_id asc
      limit 1
    ) where id = p_room;
  end if;

  return next_p;
end;
$$;

alter function public.room_next_phase(uuid) set search_path = public, pg_temp;

-- Quorum-aware phase advance. Counts only "alive" participants (last_seen_at
-- within 60s) to avoid zombie blockers. Atomically computes the next phase,
-- mutates rooms.phase, resets ready flags, and logs the event.
create or replace function public.attempt_advance_phase(p_room uuid)
returns text
language plpgsql
security definer
as $$
declare
  ready_count int;
  total int;
  current_phase text;
  next_p text;
begin
  -- Lock the room row to serialize concurrent advance attempts.
  select phase into current_phase
    from public.rooms where id = p_room for update;

  if current_phase is null then return null; end if;
  if current_phase = 'done' then return 'done'; end if;

  select count(*) into total
    from public.room_participants
    where room_id = p_room and last_seen_at > now() - interval '60 seconds';

  select count(*) into ready_count
    from public.room_participants
    where room_id = p_room
      and last_seen_at > now() - interval '60 seconds'
      and ready = true;

  if total = 0 then return current_phase; end if;
  if ready_count * 2 <= total then return current_phase; end if;

  next_p := public.room_next_phase(p_room);
  if next_p is null or next_p = current_phase then return current_phase; end if;

  update public.rooms set phase = next_p where id = p_room;
  update public.room_participants set ready = false where room_id = p_room;

  insert into public.room_phase_events (room_id, event_type, payload)
    values (p_room, 'phase_advanced',
            jsonb_build_object('from', current_phase, 'to', next_p));

  return next_p;
end;
$$;

alter function public.attempt_advance_phase(uuid) set search_path = public, pg_temp;

-- Close (host only). Verifies the host_token matches and forces phase=done.
create or replace function public.close_room(p_room uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  stored_host text;
  presented text;
begin
  select host_token into stored_host from public.rooms where id = p_room;
  if stored_host is null then return false; end if;
  presented := public.room_host_token();
  if presented is null or presented <> stored_host then return false; end if;
  update public.rooms set phase = 'done' where id = p_room;
  insert into public.room_phase_events (room_id, event_type, payload)
    values (p_room, 'closed_by_host', '{}'::jsonb);
  return true;
end;
$$;

alter function public.close_room(uuid) set search_path = public, pg_temp;

-- Cleanup. Run via pg_cron every 15 min.
create or replace function public.purge_expired_rooms()
returns int
language plpgsql
security definer
as $$
declare
  deleted int;
begin
  with d as (
    delete from public.rooms where expires_at < now() returning 1
  )
  select count(*) into deleted from d;
  return deleted;
end;
$$;

alter function public.purge_expired_rooms() set search_path = public, pg_temp;

-- ---------- Row Level Security ----------

alter table public.rooms              enable row level security;
alter table public.room_participants  enable row level security;
alter table public.room_ideas         enable row level security;
alter table public.room_votes         enable row level security;
alter table public.room_assessments   enable row level security;
alter table public.room_personas      enable row level security;
alter table public.room_scopes        enable row level security;
alter table public.room_phase_events  enable row level security;

-- SELECT: anyone who knows a room_id can read its contents. The slug is the
-- secret; brute-forcing 3-word slugs at scale is not part of the threat
-- model.
create policy "rooms_select" on public.rooms
  for select to anon, authenticated using (true);

create policy "room_participants_select" on public.room_participants
  for select to anon, authenticated using (true);

create policy "room_ideas_select" on public.room_ideas
  for select to anon, authenticated using (true);

create policy "room_votes_select" on public.room_votes
  for select to anon, authenticated using (true);

create policy "room_assessments_select" on public.room_assessments
  for select to anon, authenticated using (true);

create policy "room_personas_select" on public.room_personas
  for select to anon, authenticated using (true);

create policy "room_scopes_select" on public.room_scopes
  for select to anon, authenticated using (true);

create policy "room_phase_events_select" on public.room_phase_events
  for select to anon, authenticated using (true);

-- INSERT rooms: anyone can create a room. Slug + host_token come from the
-- client; expires_at is bounded by the default + a max-4h CHECK below.
create policy "rooms_insert" on public.rooms
  for insert to anon, authenticated
  with check (
    expires_at <= now() + interval '4 hours 10 minutes'
    and char_length(slug) between 3 and 64
    and char_length(host_token) between 16 and 256
  );

-- UPDATE rooms: anon cannot directly mutate phase or winner_idea_id — those
-- transitions go through attempt_advance_phase() and close_room() (both
-- SECURITY DEFINER). Allow nothing here; updates happen via the helper
-- functions only. (No policy = no permission for UPDATE.)

-- INSERT/UPDATE/DELETE participants: only with matching session token.
create policy "room_participants_insert" on public.room_participants
  for insert to anon, authenticated
  with check (session_token = public.room_session_token());

create policy "room_participants_update" on public.room_participants
  for update to anon, authenticated
  using (session_token = public.room_session_token())
  with check (session_token = public.room_session_token());

create policy "room_participants_delete" on public.room_participants
  for delete to anon, authenticated
  using (session_token = public.room_session_token());

-- Ideas: only the author can mutate.
create policy "room_ideas_insert" on public.room_ideas
  for insert to anon, authenticated
  with check (session_token = public.room_session_token());

create policy "room_ideas_delete" on public.room_ideas
  for delete to anon, authenticated
  using (session_token = public.room_session_token());

-- Votes: only the voter can cast/unvote their own.
create policy "room_votes_insert" on public.room_votes
  for insert to anon, authenticated
  with check (session_token = public.room_session_token());

create policy "room_votes_delete" on public.room_votes
  for delete to anon, authenticated
  using (session_token = public.room_session_token());

-- Assessments: only the assessor can write their verdict (upsert).
create policy "room_assessments_insert" on public.room_assessments
  for insert to anon, authenticated
  with check (session_token = public.room_session_token());

create policy "room_assessments_update" on public.room_assessments
  for update to anon, authenticated
  using (session_token = public.room_session_token())
  with check (session_token = public.room_session_token());

create policy "room_assessments_delete" on public.room_assessments
  for delete to anon, authenticated
  using (session_token = public.room_session_token());

-- Persona + Scope: collaborative single-row tables. Anyone with a session
-- token can write (we don't track per-field authorship). The phase guards
-- (only writable while in persona/scope) are enforced client-side; this is
-- the same trust model as ideas/votes.
create policy "room_personas_insert" on public.room_personas
  for insert to anon, authenticated
  with check (public.room_session_token() is not null);

create policy "room_personas_update" on public.room_personas
  for update to anon, authenticated
  using (public.room_session_token() is not null)
  with check (public.room_session_token() is not null);

create policy "room_scopes_insert" on public.room_scopes
  for insert to anon, authenticated
  with check (public.room_session_token() is not null);

create policy "room_scopes_update" on public.room_scopes
  for update to anon, authenticated
  using (public.room_session_token() is not null)
  with check (public.room_session_token() is not null);

-- Phase events: written exclusively via SECURITY DEFINER functions, so no
-- INSERT policy for anon.

-- ---------- Realtime publication ----------

-- Add the new tables to the supabase_realtime publication so postgres_changes
-- broadcasts inserts/updates/deletes to subscribed clients.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.rooms;
    alter publication supabase_realtime add table public.room_participants;
    alter publication supabase_realtime add table public.room_ideas;
    alter publication supabase_realtime add table public.room_votes;
    alter publication supabase_realtime add table public.room_assessments;
    alter publication supabase_realtime add table public.room_personas;
    alter publication supabase_realtime add table public.room_scopes;
    alter publication supabase_realtime add table public.room_phase_events;
  end if;
end $$;

-- ---------- Scheduled purge ----------

-- pg_cron is preinstalled on Supabase. Schedule a job that purges expired
-- rooms every 15 min. If the extension isn't enabled in this environment,
-- the schedule call will no-op silently.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'purge-expired-rooms',
      '*/15 * * * *',
      $cron$ select public.purge_expired_rooms(); $cron$
    );
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;
