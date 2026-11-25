-- Applied to production via Supabase MCP on 20 November 2026.
-- One-time organiser-requested extension. Keep the published-round lock unchanged.
-- The migration transaction restores the trigger or rolls back in full.
lock table public.league_rounds in share row exclusive mode;
alter table public.league_rounds disable trigger league_round_lock;
do $$
declare changed integer;
begin
  update public.league_rounds
  set closes_at = '2026-11-30 23:59:59+11'::timestamptz
  where title = 'Test round'
    and opens_at = '2026-03-01 09:10:00+00'::timestamptz
    and closes_at = '2026-11-22 09:10:00+00'::timestamptz
    and published;
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'Expected exactly one matching published test round; rolling back';
  end if;
end $$;
alter table public.league_rounds enable trigger league_round_lock;
