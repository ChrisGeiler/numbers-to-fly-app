-- One versioned document per account. Compare-and-swap updates let clients
-- merge independent device edits instead of replacing a stale whole document.
create table public.reference_point_stores (
  user_id uuid primary key references auth.users(id) on delete cascade,
  store jsonb not null check (
    coalesce(jsonb_typeof(store) = 'object'
    and store ->> 'version' = '1'
    and jsonb_typeof(store -> 'groups') = 'array', false)
  ),
  revision integer not null default 1 check (revision > 0)
);

alter table public.reference_point_stores enable row level security;
revoke all on public.reference_point_stores from anon, authenticated;
grant select, insert, update on public.reference_point_stores to authenticated;

create policy "Read own reference points"
on public.reference_point_stores for select to authenticated
using ((select auth.uid()) = user_id and (select public.current_user_has_app_access()));

create policy "Create own reference points"
on public.reference_point_stores for insert to authenticated
with check ((select auth.uid()) = user_id and (select public.current_user_has_app_access()));

create policy "Update own reference points"
on public.reference_point_stores for update to authenticated
using ((select auth.uid()) = user_id and (select public.current_user_has_app_access()))
with check ((select auth.uid()) = user_id and (select public.current_user_has_app_access()));
