-- Permission/category regression checks. All fixtures are rolled back.
begin;
set local statement_timeout = '20s';
select set_config('league.cat_user',gen_random_uuid()::text,true);
select set_config('league.cat_round',gen_random_uuid()::text,true);
select set_config('league.cat_entry',gen_random_uuid()::text,true);
insert into auth.users(id,email) values(current_setting('league.cat_user')::uuid,'league-category-test@example.invalid');
insert into public.league_registrations(user_id,public_name,region,status)
values(current_setting('league.cat_user')::uuid,'Category test','NSWPC','approved');
insert into public.league_rounds(id,title,opens_at,closes_at,published)
values(current_setting('league.cat_round')::uuid,'Category regression fixture',now()-interval '1 day',now()+interval '1 day',true);
select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.cat_user'),'email','league-category-test@example.invalid','role','authenticated')::text,true);
set local role authenticated;
insert into storage.objects(bucket_id,name,owner_id)
values('league-tracks',current_setting('league.cat_user')||'/'||current_setting('league.cat_round')||'/'||current_setting('league.cat_entry')||'.csv',current_setting('league.cat_user'));
insert into public.league_entries(id,user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path,category)
values(current_setting('league.cat_entry')::uuid,current_setting('league.cat_user')::uuid,current_setting('league.cat_round')::uuid,
'Category test','NSWPC','speed','Moruya',5,current_setting('league.cat_user')||'/'||current_setting('league.cat_round')||'/'||current_setting('league.cat_entry')||'.csv','beginner');
do $$ declare changes jsonb; begin
  select jsonb_build_object('public_name',e.public_name,'region',e.region,'discipline',e.discipline,
    'location_name',e.location_name,'ground_elevation_m',e.ground_elevation_m,
    'coaching_requested',false,'file_path',e.file_path,'category','invalid') into changes
  from public.league_entries e where e.id=current_setting('league.cat_entry')::uuid;
  begin
    perform public.league_edit_entry(current_setting('league.cat_entry')::uuid,0,changes);
    raise exception 'Invalid category accepted';
  exception when raise_exception then if sqlerrm<>'Invalid entry changes' then raise; end if; end;
  perform public.league_edit_entry(current_setting('league.cat_entry')::uuid,0,changes||'{"category":"intermediate"}');
  if not exists(select 1 from public.league_entries where id=current_setting('league.cat_entry')::uuid
    and category='intermediate' and revision=1 and status='pending' and scoring_version is null and replay_data is null)
  then raise exception 'Category edit did not invalidate the pending result'; end if;
end $$;
reset role;
update public.league_entries set status='approved',time_s=50,raw_speed_kmh=150,raw_distance_m=2000,
  corrected_speed_kmh=150,corrected_distance_m=2000,replay_data='{"version":1,"points":[]}'
where id=current_setting('league.cat_entry')::uuid;
insert into public.league_entries(user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path,category,status,time_s,corrected_speed_kmh,corrected_distance_m,replay_data)
select current_setting('league.cat_user')::uuid,current_setting('league.cat_round')::uuid,'Category test','NSWPC','speed','Moruya',5,
  current_setting('league.cat_user')||'/'||current_setting('league.cat_round')||'/'||gen_random_uuid()||'.csv',category,'approved',50,200,2500,'{"version":1,"points":[]}'
from unnest(array['beginner','open']) category;
set local role authenticated;
do $$ declare changes jsonb; begin
  select jsonb_build_object('public_name',e.public_name,'region',e.region,'discipline',e.discipline,
    'location_name',e.location_name,'ground_elevation_m',e.ground_elevation_m,
    'coaching_requested',false,'file_path',e.file_path,'category','open') into changes
  from public.league_entries e where e.id=current_setting('league.cat_entry')::uuid;
  begin
    perform public.league_edit_entry(current_setting('league.cat_entry')::uuid,1,changes);
    raise exception 'Approved category edited';
  exception when raise_exception then if sqlerrm<>'Only your own pending entries can be edited' then raise; end if; end;
end $$;
reset role;
set local role anon;
do $$ declare ids uuid[]; begin
  if (select count(*) from public.league_round_scoreboard(current_setting('league.cat_round')::uuid))<>3
    or exists(select 1 from public.league_round_scoreboard(current_setting('league.cat_round')::uuid) where attempt<>1)
  then raise exception 'Category scoreboard attempts mixed'; end if;
  select array_agg(s.id) into ids from public.league_round_scoreboard(current_setting('league.cat_round')::uuid) s;
  if exists(select 1 from public.league_replay_tracks(ids) where attempt<>1)
  then raise exception 'Replay category attempt numbers mixed'; end if;
end $$;
reset role;
rollback;
select 'Category insert/edit/privacy/attempt checks passed; fixtures rolled back' as result;
