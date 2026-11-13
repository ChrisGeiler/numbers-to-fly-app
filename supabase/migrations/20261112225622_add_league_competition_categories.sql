-- Existing entries retain their scores and are assigned to Open.
alter table public.league_entries add column category text not null default 'open'
  check (category in ('beginner','intermediate','open'));
grant insert(category) on public.league_entries to authenticated;

-- Preserve the seven-field editor contract for previously loaded clients.
create or replace function public.league_edit_entry(entry_id uuid, expected_revision integer, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare saved public.league_entries; replacement_path text;
begin
  if auth.uid() is null or not coalesce(league_private.can_enter_league(),false)
  then raise exception 'Approved registration required'; end if;
  select * into saved from public.league_entries e where e.id=entry_id and e.user_id=auth.uid() for update;
  if not found or saved.status <> 'pending' then raise exception 'Only your own pending entries can be edited'; end if;
  if saved.revision is distinct from expected_revision then raise exception 'Entry changed. Refresh before editing'; end if;
  if not exists(select 1 from public.league_rounds r where r.id=saved.round_id and r.published and now()>=r.opens_at and now()<r.closes_at)
  then raise exception 'Entries can only be edited while the round is open'; end if;
  if jsonb_typeof(changes) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(changes)) not in (7,8)
    or exists(select 1 from jsonb_object_keys(changes) as key where key not in
      ('public_name','region','discipline','location_name','ground_elevation_m','coaching_requested','file_path','category'))
    or (changes ? 'category' and (jsonb_typeof(changes->'category') is distinct from 'string' or changes->>'category' not in ('beginner','intermediate','open')))
    or jsonb_typeof(changes->'public_name') is distinct from 'string'
    or jsonb_typeof(changes->'location_name') is distinct from 'string'
    or jsonb_typeof(changes->'region') is distinct from 'string'
    or jsonb_typeof(changes->'discipline') is distinct from 'string'
    or jsonb_typeof(changes->'file_path') is distinct from 'string'
    or jsonb_typeof(changes->'ground_elevation_m') is distinct from 'number'
    or jsonb_typeof(changes->'coaching_requested') is distinct from 'boolean'
  then raise exception 'Invalid entry changes'; end if;
  if length(trim(changes->>'public_name')) not between 2 and 60
    or length(trim(changes->>'location_name')) not between 2 and 100
    or changes->>'region' not in ('ACT','NSW','NT','QLD','SA','VIC','WA')
    or changes->>'discipline' not in ('speed','time','distance')
    or (changes->>'ground_elevation_m')::double precision not between -100 and 3000
  then raise exception 'Invalid entry details'; end if;
  replacement_path := changes->>'file_path';
  if replacement_path !~ ('^'||auth.uid()::text||'/'||saved.round_id::text||'/[0-9a-f-]{36}[.]csv$')
    or not exists(select 1 from storage.objects o where o.bucket_id='league-tracks' and o.name=replacement_path and o.owner_id=auth.uid()::text)
  then raise exception 'Upload your own replacement track before saving'; end if;
  update public.league_entries e set public_name=trim(changes->>'public_name'), region=changes->>'region',
    category=coalesce(changes->>'category',saved.category),
    discipline=changes->>'discipline',location_name=trim(changes->>'location_name'),
    ground_elevation_m=(changes->>'ground_elevation_m')::double precision,
    coaching_requested=(changes->>'coaching_requested')::boolean,file_path=replacement_path,
    revision=e.revision+1,submitted_at=now(),time_s=null,raw_speed_kmh=null,raw_distance_m=null,
    corrected_speed_kmh=null,corrected_distance_m=null,scoring_version=null,wind_snapshot=null,
    replay_data=null,file_hash=null,jump_at=null,reviewed_at=null,reviewed_by=null
  where e.id=saved.id;
end;
$$;
revoke all on function public.league_edit_entry(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.league_edit_entry(uuid,integer,jsonb) to authenticated;


-- The public projection adds category without exposing private entry data.
drop function public.league_round_scoreboard(uuid);
create function public.league_round_scoreboard(selected_round uuid)
returns table (id uuid, competitor_key uuid, public_name text, region text,
  discipline text, category text, attempt bigint, replay_available boolean, time_s double precision,
  corrected_speed_kmh double precision, corrected_distance_m double precision,
  raw_speed_kmh double precision, raw_distance_m double precision)
language sql stable security definer set search_path = '' as $$
  select e.id, e.user_id, e.public_name, e.region, e.discipline, e.category,
    row_number() over (partition by e.user_id, e.discipline, e.category order by e.submitted_at, e.id),
    e.replay_data is not null, e.time_s, e.corrected_speed_kmh, e.corrected_distance_m,
    e.raw_speed_kmh, e.raw_distance_m
  from public.league_entries e join public.league_rounds r on r.id = e.round_id
  where e.round_id = selected_round and r.published and e.status = 'approved'
  order by e.submitted_at, e.id;
$$;
revoke all on function public.league_round_scoreboard(uuid) from public;
grant execute on function public.league_round_scoreboard(uuid) to anon, authenticated;

create or replace function public.league_replay_tracks(entry_ids uuid[])
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
        row_number() over (partition by e.round_id, e.user_id, e.discipline, e.category order by e.submitted_at, e.id) as jump_number
      from public.league_entries e join public.league_rounds r on r.id = e.round_id
      where e.status = 'approved' and r.published
    )
    select n.id, n.public_name, n.discipline, n.jump_number, n.replay_data
    from numbered n where n.id = any(entry_ids);
end;
$$;
revoke all on function public.league_replay_tracks(uuid[]) from public;
grant execute on function public.league_replay_tracks(uuid[]) to anon, authenticated;
