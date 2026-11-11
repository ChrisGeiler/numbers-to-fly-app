-- Prepared for local review only. Not applied to the hosted project.
alter table public.league_entries add column revision integer not null default 0 check (revision >= 0);

create function public.league_edit_entry(entry_id uuid, expected_revision integer, changes jsonb)
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
    or (select count(*) from jsonb_object_keys(changes)) <> 7
    or exists(select 1 from jsonb_object_keys(changes) as key where key not in
      ('public_name','region','discipline','location_name','ground_elevation_m','coaching_requested','file_path'))
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

-- One temporary replacement upload is allowed at the 12-entry cap. New entry
-- INSERTs remain capped, and the old object can only be cleaned up after unlinking.
create function league_private.can_upload_with_replacement(round_folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (league_private.upload_count(round_folder)<12 or (
    league_private.upload_count(round_folder)=12
    and exists(select 1 from public.league_entries e where e.user_id=auth.uid() and e.round_id::text=round_folder and e.status='pending')
    and not exists(select 1 from storage.objects o where o.bucket_id='league-tracks'
      and (storage.foldername(o.name))[1]=auth.uid()::text and (storage.foldername(o.name))[2]=round_folder
      and not exists(select 1 from public.league_entries e where e.file_path=o.name))
  ));
$$;
revoke all on function league_private.can_upload_with_replacement(text) from public,anon,authenticated;
grant execute on function league_private.can_upload_with_replacement(text) to authenticated;
create function league_private.entry_count(selected_round uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from public.league_entries e where e.user_id=auth.uid() and e.round_id=selected_round;
$$;
revoke all on function league_private.entry_count(uuid) from public,anon,authenticated;
grant execute on function league_private.entry_count(uuid) to authenticated;
create policy "Limit league entries per round" on public.league_entries as restrictive for insert to authenticated
with check (league_private.entry_count(round_id)<12);
drop policy "Upload private league tracks during open rounds" on storage.objects;
create policy "Upload private league tracks during open rounds" on storage.objects for insert to authenticated with check (
  bucket_id='league-tracks' and (storage.foldername(name))[1]=(select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}[.]csv$'
  and exists(select 1 from public.league_rounds r where r.id::text=(storage.foldername(name))[2] and r.published and now()>=r.opens_at and now()<r.closes_at)
  and league_private.can_upload_with_replacement((storage.foldername(name))[2])
);

drop function public.league_review_entry(uuid,text,text);
create function public.league_review_entry(entry_id uuid,decision text,note text default '',expected_revision integer default 0)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.current_user_is_app_owner(),false) then raise exception 'Owner access required'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  update public.league_entries e set status=decision,review_note=left(note,2000),reviewed_at=now(),reviewed_by=auth.uid()
  where e.id=entry_id and e.revision=expected_revision and (decision='rejected' or (
    e.time_s is not null and e.corrected_speed_kmh is not null and e.corrected_distance_m is not null
    and e.wind_snapshot->>'model'='gfs_global' and e.scoring_version='pilot-v1'
    and e.jump_at >= (select r.opens_at from public.league_rounds r where r.id=e.round_id)
    and e.jump_at < (select r.closes_at from public.league_rounds r where r.id=e.round_id)
  ));
  if not found then raise exception 'Entry changed or needs recalculation. Refresh and review before approving'; end if;
end;
$$;
revoke all on function public.league_review_entry(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.league_review_entry(uuid,text,text,integer) to authenticated;
