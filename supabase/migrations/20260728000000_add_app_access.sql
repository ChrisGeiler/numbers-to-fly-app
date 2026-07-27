-- Invitation-only access for Numbers to Fly.
-- The owner can manage this list from inside the app.

create table if not exists public.app_access (
  email text primary key,
  role text not null default 'user' check (role in ('owner', 'user')),
  created_at timestamptz not null default now(),
  added_by uuid references auth.users(id),
  constraint app_access_email_normalized
    check (email = lower(trim(email)) and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

alter table public.app_access enable row level security;

create or replace function public.current_user_is_app_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_access
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and role = 'owner'
  );
$$;

create or replace function public.current_user_has_app_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_access
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.current_user_is_app_owner() from public;
revoke all on function public.current_user_has_app_access() from public;
grant execute on function public.current_user_is_app_owner() to authenticated;
grant execute on function public.current_user_has_app_access() to authenticated;

drop policy if exists "Users can read their own access" on public.app_access;
drop policy if exists "Owners can read all access" on public.app_access;
drop policy if exists "Owners can add access" on public.app_access;
drop policy if exists "Owners can update access" on public.app_access;
drop policy if exists "Owners can remove access" on public.app_access;

create policy "Users can read their own access"
on public.app_access
for select
to authenticated
using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "Owners can read all access"
on public.app_access
for select
to authenticated
using (public.current_user_is_app_owner());

create policy "Owners can add access"
on public.app_access
for insert
to authenticated
with check (public.current_user_is_app_owner());

create policy "Owners can update access"
on public.app_access
for update
to authenticated
using (public.current_user_is_app_owner())
with check (public.current_user_is_app_owner());

create policy "Owners can remove access"
on public.app_access
for delete
to authenticated
using (public.current_user_is_app_owner());

revoke all on public.app_access from anon;
grant select, insert, update, delete on public.app_access to authenticated;

insert into public.app_access (email, role)
values
  ('flywithcruza@gmail.com', 'owner'),
  ('marin.mercier@gmail.com', 'user')
on conflict (email) do update
set role = excluded.role;

-- Existing logbook rows remain private to their owners, and this restrictive
-- policy additionally requires the signed-in email to be on the allowlist.
do $$
begin
  if to_regclass('public.jumps') is not null then
    execute 'drop policy if exists "Approved app users only" on public.jumps';
    execute $policy$
      create policy "Approved app users only"
      on public.jumps
      as restrictive
      for all
      to authenticated
      using (public.current_user_has_app_access())
      with check (public.current_user_has_app_access())
    $policy$;
  end if;
end
$$;
