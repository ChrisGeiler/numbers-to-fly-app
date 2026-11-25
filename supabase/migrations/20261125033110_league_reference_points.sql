-- Reference points remain private until an entry is approved. The public flight
-- endpoint then exposes only the exit-to-1450m ground track and selected point.
create function league_private.valid_reference_point(point jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case when jsonb_typeof(point) = 'object' then
    (select count(*) = 3 from jsonb_object_keys(point))
    and jsonb_typeof(point->'name') = 'string'
    and length(trim(point->>'name')) between 1 and 100
    and case when jsonb_typeof(point->'lat') = 'number' and jsonb_typeof(point->'lon') = 'number'
      then (point->>'lat')::numeric between -90 and 90 and (point->>'lon')::numeric between -180 and 180
      else false end
    else false end, false);
$$;
revoke all on function league_private.valid_reference_point(jsonb) from public;
-- CHECK expressions execute as the writer; authenticated inserts need this predicate.
grant usage on schema league_private to authenticated;
grant execute on function league_private.valid_reference_point(jsonb) to authenticated,service_role;
alter table public.league_entries add column reference_point jsonb
  check (reference_point is null or league_private.valid_reference_point(reference_point));
grant insert(reference_point) on public.league_entries to authenticated;

create function league_private.require_entry_reference() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (tg_op = 'INSERT' or new.status = 'approved')
    and not league_private.valid_reference_point(new.reference_point)
  then raise exception 'Select the reference point flown towards before submitting or approving'; end if;
  return new;
end;
$$;
revoke all on function league_private.require_entry_reference() from public;
create trigger league_entry_reference_required before insert or update of status
on public.league_entries for each row execute function league_private.require_entry_reference();

-- Retain all existing owner/round/revision/file checks in the private implementation.
alter function public.league_edit_entry(uuid,integer,jsonb) set schema league_private;
alter function league_private.league_edit_entry(uuid,integer,jsonb) rename to edit_entry_without_reference;
revoke all on function league_private.edit_entry_without_reference(uuid,integer,jsonb) from public,anon,authenticated;
create function public.league_edit_entry(entry_id uuid, expected_revision integer, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not league_private.valid_reference_point(changes->'reference_point') then
    raise exception 'Select a valid flight reference point';
  end if;
  perform league_private.edit_entry_without_reference(entry_id,expected_revision,changes-'reference_point');
  update public.league_entries e set reference_point=changes->'reference_point' where e.id=entry_id;
end;
$$;
revoke all on function public.league_edit_entry(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.league_edit_entry(uuid,integer,jsonb) to authenticated;

-- Metadata correction for pending AND already approved entries. Do not discard
-- scores, saved winds, originals, approval or the original submission timestamp.
create function public.league_set_reference_point(entry_id uuid, expected_revision integer, reference_point jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(public.current_user_is_app_owner(),false) then
    raise exception 'Owner access required'; end if;
  if not league_private.valid_reference_point(reference_point) then
    raise exception 'Select a valid flight reference point'; end if;
  update public.league_entries e set reference_point=league_set_reference_point.reference_point,
    revision=e.revision+1,comp_run_data=null
  where e.id=entry_id and e.revision=expected_revision;
  if not found then raise exception 'Entry changed. Refresh before saving the reference point'; end if;
end;
$$;
revoke all on function public.league_set_reference_point(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.league_set_reference_point(uuid,integer,jsonb) to authenticated;
