-- All fixtures and the temporary transport stub roll back. No email is sent.
begin;
set local statement_timeout = '20s';
select set_config('league.notification_user', gen_random_uuid()::text, true);
insert into auth.users(id,email) values
  (current_setting('league.notification_user')::uuid,'notification-test@example.invalid');
select set_config('request.jwt.claims', json_build_object(
  'sub',current_setting('league.notification_user'),
  'email','notification-test@example.invalid','role','authenticated')::text,true);
set local role authenticated;
insert into public.league_registrations(user_id,public_name,region)
values(current_setting('league.notification_user')::uuid,'Notification <test>','SQPC');
do $$ begin
  if has_table_privilege('authenticated','league_private.registration_notifications','select')
    or has_table_privilege('authenticated','league_private.registration_notifications','insert')
    or has_function_privilege('authenticated','league_private.deliver_registration_notifications()','execute')
    or has_function_privilege('anon','league_private.deliver_registration_notifications()','execute')
    or has_function_privilege('authenticated','league_private.queue_registration_notification()','execute')
    or has_function_privilege('authenticated','league_private.send_registration_email(jsonb,text,uuid)','execute')
  then raise exception 'Notification internals exposed'; end if;
  if not exists(select 1 from public.league_registrations
    where user_id=current_setting('league.notification_user')::uuid and status='pending')
  then raise exception 'Notification changed registration access'; end if;
end $$;
reset role;
do $$ declare mail jsonb; begin
  select payload into strict mail from league_private.registration_notifications
  where registration_id=current_setting('league.notification_user')::uuid;
  if mail->'to' <> '["flywithcruza@gmail.com"]'::jsonb
    or mail->>'text' not like '%Notification <test>%SQPC%'
    or mail->>'text' not like '%https://numbers.flywithcruza.com/ozleague/#registration%'
    or mail->>'text' like '%notification-test@example.invalid%' or mail ? 'html'
  then raise exception 'Incorrect or excessive notification content'; end if;
end $$;
update public.league_registrations set status='approved'
where user_id=current_setting('league.notification_user')::uuid;
do $$ begin
  if (select count(*) from league_private.registration_notifications
    where registration_id=current_setting('league.notification_user')::uuid) <> 1
  then raise exception 'Approval queued duplicate mail'; end if;
end $$;

-- Replace only the private transport for this transaction. Do not capture keys.
create temp table notification_test_calls(id uuid,payload jsonb);
create or replace function league_private.send_registration_email(payload jsonb, api_key text, notification_id uuid)
returns integer language plpgsql set search_path = '' as $$
begin
  insert into pg_temp.notification_test_calls values(notification_id,payload);
  return nullif(current_setting('league.mock_status',true),'')::integer;
end $$;
update league_private.registration_notifications
set next_attempt_at=now()+interval '1 day'
where registration_id<>current_setting('league.notification_user')::uuid;
do $$ begin
  if not exists(select 1 from vault.secrets where name='oz_league_resend_api_key') then
    perform league_private.deliver_registration_notifications();
    if exists(select 1 from pg_temp.notification_test_calls) then raise exception 'Sent without key'; end if;
    perform vault.create_secret('re_placeholder_never_sent','oz_league_resend_api_key');
  end if;
end $$;
select set_config('league.mock_status','503',true);
select league_private.deliver_registration_notifications();
do $$ begin
  if not exists(select 1 from league_private.registration_notifications
    where registration_id=current_setting('league.notification_user')::uuid
      and attempts=1 and failure is null and next_attempt_at>now() and last_status=503)
  then raise exception 'Transient error was not deferred for retry'; end if;
end $$;
update league_private.registration_notifications set next_attempt_at=now()
where registration_id=current_setting('league.notification_user')::uuid;
select set_config('league.mock_status','200',true);
select league_private.deliver_registration_notifications();
select league_private.deliver_registration_notifications();
do $$ begin
  if (select count(*) from pg_temp.notification_test_calls)<>2
    or (select count(distinct id) from pg_temp.notification_test_calls)<>1
    or (select count(distinct payload) from pg_temp.notification_test_calls)<>1
    or not exists(select 1 from league_private.registration_notifications
      where registration_id=current_setting('league.notification_user')::uuid
        and attempts=2 and accepted_at is not null and failure is null)
  then raise exception 'Successful delivery retried or payload changed'; end if;
end $$;
update league_private.registration_notifications set accepted_at=null,next_attempt_at=now()
where registration_id=current_setting('league.notification_user')::uuid;
select set_config('league.mock_status','403',true);
select league_private.deliver_registration_notifications();
do $$ begin
  if not exists(select 1 from league_private.registration_notifications
    where registration_id=current_setting('league.notification_user')::uuid and failure is not null)
  then raise exception 'Invalid configuration did not stop retries'; end if;
end $$;
update league_private.registration_notifications set failure=null,next_attempt_at=now(),attempts=7
where registration_id=current_setting('league.notification_user')::uuid;
select set_config('league.mock_status','',true);
select league_private.deliver_registration_notifications();
do $$ begin
  if not exists(select 1 from league_private.registration_notifications
    where registration_id=current_setting('league.notification_user')::uuid
      and attempts=8 and failure='Retry limit reached')
  then raise exception 'Network failures retried indefinitely'; end if;
end $$;
update league_private.registration_notifications set failure=null,next_attempt_at=now(),
  first_attempt_at=now()-interval '24 hours'
where registration_id=current_setting('league.notification_user')::uuid;
select league_private.deliver_registration_notifications();
do $$ begin
  if not exists(select 1 from league_private.registration_notifications
    where registration_id=current_setting('league.notification_user')::uuid and attempts=8
      and failure='Delivery uncertain; inspect Resend before manually retrying')
  then raise exception 'Retried outside idempotency window'; end if;
end $$;
rollback;
select 'Registration notification checks passed; fixtures and transport stub rolled back' as result;
