-- Counting storage rows inside their own RLS policy causes recursion.
-- Keep this narrowly scoped helper outside the exposed public schema.
create schema if not exists league_private;
revoke all on schema league_private from public,anon;
grant usage on schema league_private to authenticated;
create function league_private.upload_count(round_folder text) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from storage.objects o
  where o.bucket_id = 'league-tracks'
    and (storage.foldername(o.name))[1] = auth.uid()::text
    and (storage.foldername(o.name))[2] = round_folder;
$$;
revoke all on function league_private.upload_count(text) from public,anon,authenticated;
grant execute on function league_private.upload_count(text) to authenticated;
drop policy "Upload private league tracks during open rounds" on storage.objects;
create policy "Upload private league tracks during open rounds" on storage.objects for insert to authenticated with check (
  bucket_id = 'league-tracks' and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'
  and exists (select 1 from public.league_rounds r where r.id::text = (storage.foldername(name))[2] and r.published and now() >= r.opens_at and now() < r.closes_at)
  and league_private.upload_count((storage.foldername(name))[2]) < 12
);
