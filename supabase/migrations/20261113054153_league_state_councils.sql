-- Replace geography labels with the league's state council affiliations.
-- Keep the existing region column/API name; only its values and UI label change.
alter table public.league_registrations drop constraint league_registrations_region_check;
alter table public.league_entries drop constraint league_entries_region_check;

update public.league_registrations set region = case lower(trim(public_name))
  when 'v-man' then 'NSWPC'
  when 'chris geiler' then 'SQPC'
  when 'charleen herrmann' then 'SQPC'
  else case region when 'ACT' then 'NSWPC' when 'NSW' then 'NSWPC'
    when 'VIC' then 'VTPC' when 'SA' then 'SAPC' when 'WA' then 'WAPC'
    when 'NT' then 'NTPC' else region end end;

-- Retain member affiliations on any existing entries, including approved scores.
update public.league_entries e set region=r.region
from public.league_registrations r where e.user_id=r.user_id;
update public.league_entries set region=case region
  when 'ACT' then 'NSWPC' when 'NSW' then 'NSWPC' when 'VIC' then 'VTPC'
  when 'SA' then 'SAPC' when 'WA' then 'WAPC' when 'NT' then 'NTPC' else region end;

-- Any unknown Queensland affiliation must be resolved rather than guessed.
alter table public.league_registrations add constraint league_registrations_region_check
  check (region in ('NSWPC','SQPC','VTPC','SAPC','WAPC','NTPC','NQPC'));
alter table public.league_entries add constraint league_entries_region_check
  check (region in ('NSWPC','SQPC','VTPC','SAPC','WAPC','NTPC','NQPC'));

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


