-- Applied at the organiser-authorised release on 11 November 2026.
create table public.league_registrations (
  user_id uuid primary key references auth.users(id),
  public_name text not null check (length(trim(public_name)) between 2 and 60),
  region text not null check (region in ('ACT','NSW','NT','QLD','SA','VIC','WA')),
  email text not null default lower(coalesce(auth.jwt()->>'email','')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  review_note text check (length(review_note) <= 2000)
);
alter table public.league_registrations enable row level security;
revoke all on public.league_registrations from anon,authenticated;
grant select on public.league_registrations to authenticated;
grant insert(user_id,public_name,region) on public.league_registrations to authenticated;
grant all on public.league_registrations to service_role;
create policy "Read own registration or manage as organiser" on public.league_registrations for select to authenticated
using (user_id = (select auth.uid()) or (select public.current_user_is_app_owner()));
create policy "Request own league registration" on public.league_registrations for insert to authenticated
with check (user_id = (select auth.uid()));

create function public.league_review_registration(applicant_id uuid,decision text,note text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.current_user_is_app_owner(),false) then raise exception 'Owner access required'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid registration decision'; end if;
  update public.league_registrations set status=decision,review_note=left(note,2000),reviewed_at=now(),reviewed_by=auth.uid()
  where user_id=applicant_id;
  if not found then raise exception 'Registration not found'; end if;
end $$;
revoke all on function public.league_review_registration(uuid,text,text) from public,anon,authenticated;
grant execute on function public.league_review_registration(uuid,text,text) to authenticated;

create function league_private.can_enter_league() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    coalesce(public.current_user_is_app_owner(),false)
    or exists(select 1 from public.league_registrations where user_id=auth.uid() and status='approved')
  );
$$;
revoke all on function league_private.can_enter_league() from public,anon,authenticated;
grant execute on function league_private.can_enter_league() to authenticated;

-- Restrictive policies AND this approval gate with the existing ownership,
-- original-file, round-date and upload-limit policies.
create policy "Approved registration required for league entry" on public.league_entries
as restrictive for insert to authenticated with check ((select league_private.can_enter_league()));
create policy "Approved registration required for league upload" on storage.objects
as restrictive for insert to authenticated with check (bucket_id <> 'league-tracks' or (select league_private.can_enter_league()));
