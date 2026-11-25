-- Production access checks; every fixture and mutation rolls back.
begin;
set local statement_timeout = '20s';
select set_config('league.test_user',gen_random_uuid()::text,true);
select set_config('league.test_round',gen_random_uuid()::text,true);
select set_config('league.test_entry',gen_random_uuid()::text,true);
select set_config('league.owner_email',(select email from public.app_access where role='owner' limit 1),true);
insert into auth.users(id,email) values(current_setting('league.test_user')::uuid,'reference-test@example.invalid');
insert into public.league_registrations(user_id,public_name,region,status) values(current_setting('league.test_user')::uuid,'Reference QA','NSWPC','approved');
insert into public.league_rounds(id,title,opens_at,closes_at,published) values(current_setting('league.test_round')::uuid,'Reference QA',now()-interval '1 day',now()+interval '1 day',true);
select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.test_user'),'email','reference-test@example.invalid','role','authenticated')::text,true);
set local role authenticated;
insert into storage.objects(bucket_id,name,owner_id) values('league-tracks',current_setting('league.test_user')||'/'||current_setting('league.test_round')||'/'||current_setting('league.test_entry')||'.csv',current_setting('league.test_user'));
do $$ begin
  begin
    insert into public.league_entries(id,user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path)
    values(current_setting('league.test_entry')::uuid,current_setting('league.test_user')::uuid,current_setting('league.test_round')::uuid,'Reference QA','NSWPC','speed','Test DZ',100,current_setting('league.test_user')||'/'||current_setting('league.test_round')||'/'||current_setting('league.test_entry')||'.csv');
    raise exception 'Missing reference accepted';
  exception when raise_exception then if sqlerrm <> 'Select the reference point flown towards before submitting or approving' then raise; end if; end;
end $$;
insert into public.league_entries(id,user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path,reference_point)
values(current_setting('league.test_entry')::uuid,current_setting('league.test_user')::uuid,current_setting('league.test_round')::uuid,'Reference QA','NSWPC','speed','Test DZ',100,current_setting('league.test_user')||'/'||current_setting('league.test_round')||'/'||current_setting('league.test_entry')||'.csv','{"name":"Runway","lat":-33,"lon":151}');
-- Existing edit validations, file ownership and version checks must survive the wrapper.
select public.league_edit_entry(current_setting('league.test_entry')::uuid,0,jsonb_build_object('public_name','Reference QA','region','NSWPC','discipline','time','location_name','Test DZ','ground_elevation_m',100,'coaching_requested',false,'file_path',current_setting('league.test_user')||'/'||current_setting('league.test_round')||'/'||current_setting('league.test_entry')||'.csv','reference_point',jsonb_build_object('name','Runway 2','lat',-33,'lon',151)));
do $$ begin
  if (select revision from public.league_entries where id=current_setting('league.test_entry')::uuid) <> 1 then raise exception 'Edit did not increment revision'; end if;
  begin
    perform public.league_set_reference_point(current_setting('league.test_entry')::uuid,1,'{"name":"Forbidden","lat":-33,"lon":151}');
    raise exception 'Competitor changed organiser reference';
  exception when raise_exception then if sqlerrm <> 'Owner access required' then raise; end if; end;
  if has_function_privilege('authenticated','league_private.edit_entry_without_reference(uuid,integer,jsonb)','execute') then raise exception 'Private helper exposed'; end if;
end $$;
reset role;
update public.league_entries set time_s=40,raw_distance_m=2000,raw_speed_kmh=180,corrected_distance_m=1800,corrected_speed_kmh=162,wind_snapshot='{"model":"gfs_global"}',scoring_version='pilot-v1',jump_at=now()-interval '1 hour',file_hash='reference-qa' where id=current_setting('league.test_entry')::uuid;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.test_user'),'email',current_setting('league.owner_email'),'role','authenticated')::text,true);
set local role authenticated;
select public.league_review_entry(current_setting('league.test_entry')::uuid,'approved','QA',1,'Test suit');
select public.league_set_reference_point(current_setting('league.test_entry')::uuid,1,'{"name":"Corrected runway","lat":-33.01,"lon":151.01}');
do $$ begin
  if not exists(select 1 from public.league_entries where id=current_setting('league.test_entry')::uuid and status='approved' and revision=2 and time_s=40 and corrected_speed_kmh=162 and reference_point->>'name'='Corrected runway') then raise exception 'Approved score or reference was not preserved'; end if;
  begin
    perform public.league_set_reference_point(current_setting('league.test_entry')::uuid,1,'{"name":"Stale","lat":-33,"lon":151}');
    raise exception 'Stale reference update accepted';
  exception when raise_exception then if sqlerrm <> 'Entry changed. Refresh before saving the reference point' then raise; end if; end;
  begin
    perform public.league_set_reference_point(current_setting('league.test_entry')::uuid,2,'{"name":"Bad","lat":999,"lon":151}');
    raise exception 'Invalid coordinate accepted';
  exception when raise_exception then if sqlerrm <> 'Select a valid flight reference point' then raise; end if; end;
end $$;
reset role;
set local role anon;
do $$ begin
  if has_function_privilege('anon','public.league_set_reference_point(uuid,integer,jsonb)','execute') then raise exception 'Anonymous reference writes'; end if;
  if not exists(select 1 from public.league_round_scoreboard(current_setting('league.test_round')::uuid)) then raise exception 'Approved result lost'; end if;
  if has_table_privilege('anon','public.league_entries','select') then raise exception 'Private entries exposed'; end if;
end $$;
reset role;
rollback;
select 'Reference access, validation, approved backfill and stale-write checks passed; fixtures rolled back' as result;
