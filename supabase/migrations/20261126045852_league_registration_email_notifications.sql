-- Delivery is independent of the browser and registration approval. Existing
-- registrations are deliberately not backfilled. Only new INSERTs enqueue mail.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table league_private.registration_notifications (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.league_registrations(user_id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  request_id bigint,
  requested_at timestamptz,
  accepted_at timestamptz,
  last_status integer,
  failure text
);
alter table league_private.registration_notifications enable row level security;
revoke all on league_private.registration_notifications from public, anon, authenticated, service_role;
create index registration_notifications_due on league_private.registration_notifications(next_attempt_at)
where accepted_at is null and failure is null;

-- A fixed destination prevents registration fields from being used as a mail relay.
-- Plain text avoids interpreting names as HTML. The payload stays identical on
-- retries, which is required by Resend's 24-hour idempotency guarantee.
create function league_private.queue_registration_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into league_private.registration_notifications(registration_id, payload)
  values (new.user_id, jsonb_build_object(
    'from', 'Oz League <onboarding@resend.dev>',
    'to', jsonb_build_array('flywithcruza@gmail.com'),
    'subject', 'Oz League: new competitor registration',
    'text', concat(
      'A new competitor has requested registration for Oz League.', E'\n\n',
      'Name: ', new.public_name, E'\n',
      'State council: ', new.region, E'\n',
      'Requested: ', to_char(new.requested_at at time zone 'Australia/Sydney', 'DD Mon YYYY HH24:MI'),
      ' (Sydney time)', E'\n\n',
      'Review and approve the registration:', E'\n',
      'https://numbers.flywithcruza.com/ozleague/#registration', E'\n\n',
      'Registration is still pending. This email does not grant entry access.'
    )
  )) on conflict (registration_id) do nothing;
  return new;
end;
$$;
revoke all on function league_private.queue_registration_notification() from public, anon, authenticated, service_role;
create trigger league_registration_notification
after insert on public.league_registrations
for each row execute function league_private.queue_registration_notification();

-- Runs as postgres only. No exposed RPC and no frontend/email credentials.
-- A missing key leaves requests queued, without consuming attempts.
create function league_private.deliver_registration_notifications() returns void
language plpgsql set search_path = '' as $$
declare
  item record;
  response record;
  api_key text;
  http_id bigint;
begin
  if not pg_try_advisory_xact_lock(260426, 1) then return; end if;

  for item in
    select * from league_private.registration_notifications
    where request_id is not null and accepted_at is null and failure is null
    for update skip locked
  loop
    select status_code, timed_out, error_msg into response
    from net._http_response where id = item.request_id;
    if found then
      if response.status_code between 200 and 299
         and not coalesce(response.timed_out, false) and response.error_msg is null then
        update league_private.registration_notifications
        set accepted_at = now(), last_status = response.status_code, request_id = null
        where id = item.id;
      else
        update league_private.registration_notifications
        set request_id = null, last_status = response.status_code,
            next_attempt_at = now() + make_interval(mins => least(60, power(2, attempts)::int)),
            failure = case
              when response.status_code between 400 and 499 and response.status_code not in (408, 425, 429)
                then 'Email configuration rejected; inspect Resend and requeue after fixing'
              when attempts >= 8 then 'Retry limit reached'
              else null end
        where id = item.id;
      end if;
    elsif item.requested_at < now() - interval '5 minutes' then
      -- pg_net queues/responses are unlogged; recover after a restart or timeout.
      update league_private.registration_notifications
      set request_id = null, next_attempt_at = now(),
          failure = case when attempts >= 8 then 'Retry limit reached' else null end
      where id = item.id;
    end if;
  end loop;

  -- Never retry an ambiguous send after the provider's idempotency window.
  update league_private.registration_notifications
  set failure = 'Delivery uncertain; inspect Resend before manually retrying'
  where accepted_at is null and failure is null
    and first_attempt_at < now() - interval '23 hours';

  select decrypted_secret into api_key from vault.decrypted_secrets
  where name = 'oz_league_resend_api_key';
  if nullif(trim(api_key), '') is null then return; end if;

  -- One request per minute stays below Resend's API rate limit, even on retries.
  for item in
    select * from league_private.registration_notifications
    where accepted_at is null and failure is null and request_id is null
      and next_attempt_at <= now()
    order by next_attempt_at, created_at limit 1 for update skip locked
  loop
    http_id := net.http_post(
      url := 'https://api.resend.com/emails', body := item.payload,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || api_key,
        'Content-Type', 'application/json',
        'Idempotency-Key', 'oz-league-registration/' || item.id::text
      ), timeout_milliseconds := 10000
    );
    update league_private.registration_notifications
    set request_id = http_id, requested_at = now(), attempts = attempts + 1,
        first_attempt_at = coalesce(first_attempt_at, now())
    where id = item.id;
  end loop;

  -- Keep this job's history bounded; do not touch other scheduled jobs.
  delete from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'oz-league-registration-email')
    and end_time < now() - interval '7 days';
end;
$$;
revoke all on function league_private.deliver_registration_notifications() from public, anon, authenticated, service_role;
select cron.schedule('oz-league-registration-email', '* * * * *',
  'select league_private.deliver_registration_notifications();');
