-- Use synchronous HTTP only in the background cron worker, never in registration
-- transactions. No bearer key is written to pg_net's shared transport tables.
create extension if not exists http with schema extensions;

create function league_private.send_registration_email(payload jsonb, api_key text, notification_id uuid)
returns integer language plpgsql set search_path = '' as $$
declare status integer;
begin
  perform set_config('http.curlopt_timeout_ms','10000',true);
  perform set_config('http.curlopt_connecttimeout_ms','3000',true);
  select h.status into status from extensions.http((
    'POST', 'https://api.resend.com/emails',
    array[
      ('Authorization', 'Bearer ' || api_key)::extensions.http_header,
      ('Idempotency-Key', 'oz-league-registration/' || notification_id::text)::extensions.http_header
    ], 'application/json', payload::text
  )::extensions.http_request) h;
  return status;
exception when others then
  -- Do not persist or log raw network errors, headers or provider responses.
  return null;
end;
$$;
revoke all on function league_private.send_registration_email(jsonb,text,uuid) from public, anon, authenticated, service_role;

-- Remove unused asynchronous-request columns before any live email has been sent.
alter table league_private.registration_notifications drop column request_id;
-- The worker no longer reads or writes pg_net. Keep the column-free definition.
create or replace function league_private.deliver_registration_notifications() returns void
language plpgsql set search_path = '' as $$
declare item record; api_key text; result integer;
begin
  if not pg_try_advisory_xact_lock(260426, 1) then return; end if;
  delete from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'oz-league-registration-email')
    and end_time < now() - interval '7 days';
  update league_private.registration_notifications
  set failure = 'Delivery uncertain; inspect Resend before manually retrying'
  where accepted_at is null and failure is null
    and first_attempt_at < now() - interval '23 hours';
  select decrypted_secret into api_key from vault.decrypted_secrets
  where name = 'oz_league_resend_api_key';
  if nullif(trim(api_key), '') is null then return; end if;
  for item in
    select * from league_private.registration_notifications
    where accepted_at is null and failure is null and next_attempt_at <= now()
    order by next_attempt_at, created_at limit 1 for update skip locked
  loop
    result := league_private.send_registration_email(item.payload, api_key, item.id);
    update league_private.registration_notifications
    set attempts = attempts + 1,
        first_attempt_at = coalesce(first_attempt_at, now()), requested_at = now(),
        last_status = result,
        accepted_at = case when result between 200 and 299 then now() else null end,
        next_attempt_at = now() + make_interval(mins => least(60, power(2, attempts + 1)::int)),
        failure = case
          when result between 200 and 299 then null
          when result between 400 and 499 and result not in (408,425,429)
            then 'Email configuration rejected; inspect Resend and requeue after fixing'
          when attempts + 1 >= 8 then 'Retry limit reached'
          else null end
    where id = item.id;
  end loop;
end;
$$;
revoke all on function league_private.deliver_registration_notifications() from public, anon, authenticated, service_role;
select cron.alter_job(job_id := (select jobid from cron.job where jobname='oz-league-registration-email'), active := true);
