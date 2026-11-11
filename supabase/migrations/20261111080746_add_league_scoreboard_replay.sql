-- Applied at the organiser-authorised release on 11 November 2026.
-- Private originals and weather snapshots retain their existing RLS policies.
alter table public.league_entries add column replay_data jsonb;
alter table public.league_entries add constraint league_replay_object
  check (replay_data is null or (jsonb_typeof(replay_data) = 'object'
    and replay_data ->> 'version' = '1'
    and jsonb_typeof(replay_data -> 'points') = 'array'));
-- No INSERT/UPDATE grants are added: only the authoritative service can write replay.

create function public.league_round_scoreboard(selected_round uuid)
returns table (id uuid, competitor_key uuid, public_name text, region text,
  discipline text, attempt bigint, replay_available boolean, time_s double precision,
  corrected_speed_kmh double precision, corrected_distance_m double precision,
  raw_speed_kmh double precision, raw_distance_m double precision)
language sql stable security definer set search_path = '' as $$
  select e.id, e.user_id, e.public_name, e.region, e.discipline,
    row_number() over (partition by e.user_id, e.discipline order by e.submitted_at, e.id),
    e.replay_data is not null, e.time_s, e.corrected_speed_kmh, e.corrected_distance_m,
    e.raw_speed_kmh, e.raw_distance_m
  from public.league_entries e join public.league_rounds r on r.id = e.round_id
  where e.round_id = selected_round and r.published and e.status = 'approved'
  order by e.submitted_at, e.id;
$$;
revoke all on function public.league_round_scoreboard(uuid) from public;
grant execute on function public.league_round_scoreboard(uuid) to anon, authenticated;

create function public.league_replay_tracks(entry_ids uuid[])
returns table (id uuid, public_name text, discipline text, attempt bigint, replay jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare matching integer; rounds integer;
begin
  if entry_ids is null or cardinality(entry_ids) < 1 or cardinality(entry_ids) > 4
    or (select count(distinct value) from unnest(entry_ids) as value) <> cardinality(entry_ids)
  then raise exception 'Select between one and four distinct approved tracks'; end if;
  select count(*), count(distinct e.round_id) into matching, rounds
  from public.league_entries e join public.league_rounds r on r.id = e.round_id
  where e.id = any(entry_ids) and e.status = 'approved' and r.published and e.replay_data is not null;
  if matching <> cardinality(entry_ids) or rounds <> 1
  then raise exception 'Selected tracks are unavailable or no longer approved in the same round'; end if;
  return query
    with numbered as (
      select e.id, e.public_name, e.discipline, e.replay_data,
        row_number() over (partition by e.round_id, e.user_id, e.discipline order by e.submitted_at, e.id) as jump_number
      from public.league_entries e join public.league_rounds r on r.id = e.round_id
      where e.status = 'approved' and r.published
    )
    select n.id, n.public_name, n.discipline, n.jump_number, n.replay_data
    from numbered n where n.id = any(entry_ids);
end;
$$;
revoke all on function public.league_replay_tracks(uuid[]) from public;
grant execute on function public.league_replay_tracks(uuid[]) to anon, authenticated;
