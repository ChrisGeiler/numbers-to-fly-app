-- Private preview access for the Track Assessor.
-- General app access remains unchanged; this flag only controls the assessor UI.

alter table public.app_access
add column if not exists can_use_track_assessor boolean not null default false;

insert into public.app_access (email, role, can_use_track_assessor)
values
  ('flywithcruza@gmail.com', 'owner', true),
  ('starcruza@hotmail.com', 'user', true)
on conflict (email) do update
set can_use_track_assessor = excluded.can_use_track_assessor;
