-- Suit names are private until the associated jump is approved.
alter table public.league_entries add column suit_name text
  check (suit_name is null or (suit_name = trim(suit_name) and length(suit_name) between 1 and 60));
grant insert(suit_name) on public.league_entries to authenticated;

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
    or (select count(*) from jsonb_object_keys(changes)) not in (7,8,9)
    or exists(select 1 from jsonb_object_keys(changes) as key where key not in
      ('public_name','region','discipline','location_name','ground_elevation_m','coaching_requested','file_path','category','suit_name'))
    or (changes ? 'category' and (jsonb_typeof(changes->'category') is distinct from 'string' or changes->>'category' not in ('beginner','intermediate','open')))
    or (changes ? 'suit_name' and (jsonb_typeof(changes->'suit_name') is distinct from 'string' or length(trim(changes->>'suit_name')) not between 1 and 60))
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
    or changes->>'region' not in ('NSWPC','SQPC','VTPC','SAPC','WAPC','NTPC','NQPC')
    or changes->>'discipline' not in ('speed','time','distance')
    or (changes->>'ground_elevation_m')::double precision not between -100 and 3000
  then raise exception 'Invalid entry details'; end if;
  replacement_path := changes->>'file_path';
  if replacement_path !~ ('^'||auth.uid()::text||'/'||saved.round_id::text||'/[0-9a-f-]{36}[.]csv$')
    or not exists(select 1 from storage.objects o where o.bucket_id='league-tracks' and o.name=replacement_path and o.owner_id=auth.uid()::text)
  then raise exception 'Upload your own replacement track before saving'; end if;
  update public.league_entries e set public_name=trim(changes->>'public_name'), region=changes->>'region',
    category=coalesce(changes->>'category',saved.category),
    suit_name=case when changes ? 'suit_name' then trim(changes->>'suit_name') else saved.suit_name end,
    discipline=changes->>'discipline',location_name=trim(changes->>'location_name'),
    ground_elevation_m=(changes->>'ground_elevation_m')::double precision,
    coaching_requested=(changes->>'coaching_requested')::boolean,file_path=replacement_path,
    revision=e.revision+1,submitted_at=now(),time_s=null,raw_speed_kmh=null,raw_distance_m=null,
    corrected_speed_kmh=null,corrected_distance_m=null,scoring_version=null,wind_snapshot=null,
    replay_data=null,comp_run_data=null,file_hash=null,jump_at=null,reviewed_at=null,reviewed_by=null
  where e.id=saved.id;
end;
$$;
revoke all on function public.league_edit_entry(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.league_edit_entry(uuid,integer,jsonb) to authenticated;



-- Save the organiser's correction atomically with the approval decision.
-- Preserve four-argument callers using the default fifth argument.
drop function public.league_review_entry(uuid,text,text,integer);
create function public.league_review_entry(entry_id uuid, decision text, note text default '', expected_revision integer default 0, suit_name text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.current_user_is_app_owner(),false) then raise exception 'Owner access required'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  if suit_name is not null and length(trim(suit_name)) not between 1 and 60 then raise exception 'Enter a suit name between 1 and 60 characters'; end if;
  update public.league_entries e set status=decision,review_note=left(note,2000),reviewed_at=now(),reviewed_by=auth.uid(),
    suit_name=case when decision='approved' then coalesce(trim(league_review_entry.suit_name),e.suit_name) else e.suit_name end
  where e.id=entry_id and e.revision=expected_revision and (decision='rejected' or (
    e.time_s is not null and e.corrected_speed_kmh is not null and e.corrected_distance_m is not null
    and e.wind_snapshot->>'model'='gfs_global' and e.scoring_version='pilot-v1'
    and e.jump_at >= (select r.opens_at from public.league_rounds r where r.id=e.round_id)
    and e.jump_at < (select r.closes_at from public.league_rounds r where r.id=e.round_id)
  ));
  if not found then raise exception 'Entry changed or needs recalculation. Refresh and review before approving'; end if;
end;
$$;
revoke all on function public.league_review_entry(uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.league_review_entry(uuid,text,text,integer,text) to authenticated;

drop function public.league_round_scoreboard(uuid);
create function public.league_round_scoreboard(selected_round uuid)
returns table (id uuid, competitor_key uuid, public_name text, region text,
  discipline text, category text, attempt bigint, replay_available boolean, time_s double precision,
  corrected_speed_kmh double precision, corrected_distance_m double precision,
  raw_speed_kmh double precision, raw_distance_m double precision, suit_name text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.user_id, e.public_name, e.region, e.discipline, e.category,
    row_number() over (partition by e.user_id, e.discipline, e.category order by e.submitted_at, e.id),
    e.replay_data is not null, e.time_s, e.corrected_speed_kmh, e.corrected_distance_m,
    e.raw_speed_kmh, e.raw_distance_m, e.suit_name
  from public.league_entries e join public.league_rounds r on r.id = e.round_id
  where e.round_id = selected_round and r.published and e.status = 'approved'
  order by e.submitted_at, e.id;
$$;
revoke all on function public.league_round_scoreboard(uuid) from public;
grant execute on function public.league_round_scoreboard(uuid) to anon,authenticated;
