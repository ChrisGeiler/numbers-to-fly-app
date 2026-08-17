-- Allow logbook tracks that are saved for review outside a competition task.
alter table public.jumps
  drop constraint if exists jumps_task_type_check;

alter table public.jumps
  add constraint jumps_task_type_check
  check (task_type in ('speed', 'time', 'distance', 'non-comp'));
