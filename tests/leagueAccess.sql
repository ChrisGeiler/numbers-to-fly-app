-- Run against the linked project as postgres. All fixtures roll back.
begin;
set local statement_timeout = '20s';
select set_config('league.test_user',gen_random_uuid()::text,true);
select set_config('league.test_other',gen_random_uuid()::text,true);
select set_config('league.test_round',gen_random_uuid()::text,true);
select set_config('league.test_draft',gen_random_uuid()::text,true);
select set_config('league.test_entry',gen_random_uuid()::text,true);
select set_config('league.owner_email',(select email from public.app_access where role='owner' limit 1),true);
insert into auth.users(id,email) values
  (current_setting('league.test_user')::uuid,'league-access-test@example.invalid'),
  (current_setting('league.test_other')::uuid,'league-other-test@example.invalid');
-- Preserve this existing scoring/access test after the registration release.
do $$ begin
  if to_regclass('public.league_registrations') is not null then
    execute 'insert into public.league_registrations(user_id,public_name,region,status) values ($1,''Approved access fixture'',''NSWPC'',''approved'')'
      using current_setting('league.test_user')::uuid;
  end if;
end $$;
insert into public.league_rounds(id,title,opens_at,closes_at,published) values
  (current_setting('league.test_round')::uuid,'Permission test',now()-interval '1 day',now()+interval '1 day',true),
  (current_setting('league.test_draft')::uuid,'Hidden draft test',now()-interval '1 day',now()+interval '1 day',false);

set local role anon;
do $$ begin
  if exists(select 1 from public.league_rounds where id=current_setting('league.test_draft')::uuid) then raise exception 'Draft round leaked'; end if;
  if exists(select 1 from public.league_leaderboard(current_setting('league.test_round')::uuid)) then raise exception 'Unexpected result'; end if;
  if has_table_privilege('anon','public.league_entries','select') then raise exception 'Anonymous entry access'; end if;
end $$;
reset role;

select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.test_user'),'email','league-access-test@example.invalid','role','authenticated')::text,true);
set local role authenticated;
insert into storage.objects(bucket_id,name,owner_id) values
  ('league-tracks',current_setting('league.test_user') || '/' || current_setting('league.test_round') || '/' || current_setting('league.test_entry') || '.csv',current_setting('league.test_user'));
insert into public.league_entries(id,user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path)
values(current_setting('league.test_entry')::uuid,current_setting('league.test_user')::uuid,current_setting('league.test_round')::uuid,
  'Test competitor','NSWPC','speed','Test drop zone',100,current_setting('league.test_user') || '/' || current_setting('league.test_round') || '/' || current_setting('league.test_entry') || '.csv');
do $$ begin
  if public.current_user_has_app_access() then raise exception 'League membership granted app access'; end if;
  if not exists(select 1 from public.league_entries where id=current_setting('league.test_entry')::uuid) then raise exception 'Own entry inaccessible'; end if;
  begin
    update public.league_entries set corrected_speed_kmh=900 where id=current_setting('league.test_entry')::uuid;
    raise exception 'Competitor modified scores';
  exception when insufficient_privilege then null; end;
  begin
    perform public.league_review_entry(current_setting('league.test_entry')::uuid,'approved','');
    raise exception 'Competitor approved a result';
  exception when raise_exception then if sqlerrm <> 'Owner access required' then raise; end if; end;
end $$;
reset role;

select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.test_other'),'email','league-other-test@example.invalid','role','authenticated')::text,true);
set local role authenticated;
do $$ begin
  if exists(select 1 from public.league_entries where id=current_setting('league.test_entry')::uuid) then raise exception 'Another user read a private entry'; end if;
  if exists(select 1 from storage.objects where name=current_setting('league.test_user') || '/' || current_setting('league.test_round') || '/' || current_setting('league.test_entry') || '.csv') then raise exception 'Another user read a private file'; end if;
end $$;
reset role;

select set_config('request.jwt.claims',json_build_object('sub',current_setting('league.test_user'),'email',current_setting('league.owner_email'),'role','authenticated')::text,true);
set local role authenticated;
do $$ begin
  begin
    perform public.league_review_entry(current_setting('league.test_entry')::uuid,'approved','');
    raise exception 'Unscored result approved';
  exception when raise_exception then if sqlerrm <> 'Entry changed or needs recalculation. Refresh and review before approving' then raise; end if; end;
end $$;
reset role;
-- Only a trusted server can write the calculated values.
update public.league_entries set time_s=40,raw_distance_m=2000,raw_speed_kmh=180,corrected_distance_m=1800,
  corrected_speed_kmh=162,wind_snapshot='{"model":"gfs_global"}',scoring_version='pilot-v1',jump_at=now()-interval '1 hour',file_hash='test'
where id=current_setting('league.test_entry')::uuid;
set local role authenticated;
select public.league_review_entry(current_setting('league.test_entry')::uuid,'approved','Reviewed');
reset role;
set local role anon;
do $$ begin
  if not exists(select 1 from public.league_leaderboard(current_setting('league.test_round')::uuid) where public_name='Test competitor' and corrected_speed_kmh=162) then raise exception 'Approved public result missing'; end if;
end $$;
reset role;
rollback;
select 'League access checks passed; fixtures rolled back' as result;
