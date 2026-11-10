-- League participation never adds an account to app_access.
create table public.league_rounds (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 3 and 100),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  check (closes_at > opens_at)
);
alter table public.league_rounds enable row level security;
revoke all on public.league_rounds from anon,authenticated;
grant select on public.league_rounds to anon, authenticated;
grant insert, update on public.league_rounds to authenticated;
grant all on public.league_rounds to service_role;
create policy "Public reads published league rounds" on public.league_rounds for select to anon using (published);
create policy "Members read published or owned draft rounds" on public.league_rounds for select to authenticated using (published or (select public.current_user_is_app_owner()));
create policy "Owner creates league rounds" on public.league_rounds for insert to authenticated with check ((select public.current_user_is_app_owner()));
create policy "Owner edits league rounds" on public.league_rounds for update to authenticated using ((select public.current_user_is_app_owner())) with check ((select public.current_user_is_app_owner()));
-- Published rounds are immutable so eligibility cannot change after entry.
create function public.league_lock_round() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.published then raise exception 'Published rounds are locked. Create a new round instead.'; end if;
  return new;
end $$;
create trigger league_round_lock before update on public.league_rounds for each row execute function public.league_lock_round();

create table public.league_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  round_id uuid not null references public.league_rounds(id),
  public_name text not null check (length(trim(public_name)) between 2 and 60),
  region text not null check (region in ('ACT','NSW','NT','QLD','SA','TAS','VIC','WA')),
  discipline text not null check (discipline in ('speed','time','distance')),
  location_name text not null check (length(trim(location_name)) between 2 and 100),
  ground_elevation_m double precision not null check (ground_elevation_m between -100 and 3000),
  file_path text not null unique,
  coaching_requested boolean not null default false,
  consent_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text check (length(review_note) <= 2000),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  coaching_note text check (length(coaching_note) <= 6000),
  jump_at timestamptz,
  time_s double precision check (time_s > 0 and time_s < 240),
  raw_distance_m double precision check (raw_distance_m >= 0 and raw_distance_m < 50000),
  raw_speed_kmh double precision check (raw_speed_kmh >= 0 and raw_speed_kmh < 1000),
  corrected_distance_m double precision check (corrected_distance_m >= 0 and corrected_distance_m < 50000),
  corrected_speed_kmh double precision check (corrected_speed_kmh >= 0 and corrected_speed_kmh < 1000),
  wind_snapshot jsonb,
  file_hash text,
  scoring_version text,
  unique (user_id, round_id, discipline, file_hash)
);
create index league_entries_user_idx on public.league_entries(user_id, round_id);
create index league_entries_round_idx on public.league_entries(round_id, status);
alter table public.league_entries enable row level security;
revoke all on public.league_entries from anon,authenticated;
grant select on public.league_entries to authenticated;
grant insert (id,user_id,round_id,public_name,region,discipline,location_name,ground_elevation_m,file_path,coaching_requested) on public.league_entries to authenticated;
grant all on public.league_entries to service_role;
create policy "Read own league entries or review as owner" on public.league_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.current_user_is_app_owner()));
create policy "Submit an entry in an open round" on public.league_entries for insert to authenticated with check (
  user_id = (select auth.uid())
  and file_path = user_id::text || '/' || round_id::text || '/' || id::text || '.csv'
  and exists (select 1 from public.league_rounds r where r.id = round_id and r.published and now() >= r.opens_at and now() < r.closes_at)
  and exists (select 1 from storage.objects o where o.bucket_id = 'league-tracks' and o.name = file_path and o.owner_id = (select auth.uid())::text)
);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('league-tracks','league-tracks',false,8388608,array['text/csv','text/plain','application/octet-stream']);
create policy "Upload private league tracks during open rounds" on storage.objects for insert to authenticated with check (
  bucket_id = 'league-tracks' and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'
  and exists (select 1 from public.league_rounds r where r.id::text = (storage.foldername(name))[2] and r.published and now() >= r.opens_at and now() < r.closes_at)
  and (select count(*) from storage.objects o where o.bucket_id = 'league-tracks' and (storage.foldername(o.name))[1] = (select auth.uid())::text and (storage.foldername(o.name))[2] = (storage.foldername(objects.name))[2]) < 12
);
create policy "Read own league files or review as owner" on storage.objects for select to authenticated
using (bucket_id = 'league-tracks' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.current_user_is_app_owner())));
-- Only failed uploads without a submission may be cleaned up by the competitor.
create policy "Clean up unsubmitted league file" on storage.objects for delete to authenticated
using (bucket_id = 'league-tracks' and (storage.foldername(name))[1] = (select auth.uid())::text
and not exists (select 1 from public.league_entries e where e.file_path = name));

create function public.league_review_entry(entry_id uuid, decision text, note text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.current_user_is_app_owner(),false) then raise exception 'Owner access required'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  update public.league_entries e set status = decision, review_note = left(note,2000), reviewed_at = now(), reviewed_by = auth.uid()
  where e.id = entry_id and (decision = 'rejected' or (
    e.time_s is not null and e.corrected_speed_kmh is not null and e.corrected_distance_m is not null
    and e.wind_snapshot ->> 'model' = 'gfs_global' and e.scoring_version = 'pilot-v1'
    and e.jump_at >= (select opens_at from public.league_rounds where id = e.round_id)
    and e.jump_at < (select closes_at from public.league_rounds where id = e.round_id)
  ));
  if not found then raise exception 'Calculate valid scores before approving this entry'; end if;
end $$;
revoke all on function public.league_review_entry(uuid,text,text) from public;
grant execute on function public.league_review_entry(uuid,text,text) to authenticated;

create function public.league_coaching_note(entry_id uuid, note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.current_user_is_app_owner(),false) then raise exception 'Owner access required'; end if;
  update public.league_entries set coaching_note = left(note,6000) where id = entry_id;
end $$;
revoke all on function public.league_coaching_note(uuid,text) from public;
grant execute on function public.league_coaching_note(uuid,text) to authenticated;

-- A narrow public projection: no email, files, coordinates, coaching or wind payload.
create function public.league_leaderboard(selected_round uuid)
returns table (competitor_key uuid, public_name text, region text, discipline text, time_s double precision,
  corrected_speed_kmh double precision, corrected_distance_m double precision, raw_speed_kmh double precision, raw_distance_m double precision)
language sql stable security definer set search_path = '' as $$
  select distinct on (e.user_id,e.discipline) e.user_id,e.public_name,e.region,e.discipline,e.time_s,
  e.corrected_speed_kmh,e.corrected_distance_m,e.raw_speed_kmh,e.raw_distance_m
  from public.league_entries e join public.league_rounds r on r.id = e.round_id
  where e.round_id = selected_round and e.status = 'approved' and r.published
  order by e.user_id,e.discipline,
  case e.discipline when 'speed' then e.corrected_speed_kmh when 'distance' then e.corrected_distance_m else e.time_s end desc,
  e.submitted_at asc, e.id;
$$;
revoke all on function public.league_leaderboard(uuid) from public;
grant execute on function public.league_leaderboard(uuid) to anon,authenticated;
