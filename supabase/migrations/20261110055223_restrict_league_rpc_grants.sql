revoke all on function public.league_review_entry(uuid,text,text) from public,anon,authenticated;
grant execute on function public.league_review_entry(uuid,text,text) to authenticated;
revoke all on function public.league_coaching_note(uuid,text) from public,anon,authenticated;
grant execute on function public.league_coaching_note(uuid,text) to authenticated;
revoke all on function public.league_lock_round() from public,anon,authenticated;
