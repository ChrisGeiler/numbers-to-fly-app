import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { supabase } from "./supabase";
import { leagueTasks, leagueTaskUnit, leagueTaskValue, rankLeagueScoreboard } from "./leagueScoreboardModel";
import type { LeagueScoreboardEntry, LeagueTask } from "./leagueScoreboardModel";
import type { LeagueReplayData } from "./leagueReplay";
import { leagueCategories } from "./leagueCategories";
import type { LeagueCategory } from "./leagueCategories";
const LeagueReplay = lazy(() => import("./LeagueTrackReplay"));
export type ReplayTrack = { id: string; public_name: string; discipline: LeagueTask; attempt: number; replay: LeagueReplayData };

export default function LeagueScoreboard({ client, rows, roundTitle, onRefresh }: {
  client: typeof supabase; rows: LeagueScoreboardEntry[]; roundTitle: string; onRefresh: () => void;
}) {
  const [task, setTask] = useState<LeagueTask | "overall">("overall");
  const [category, setCategory] = useState<LeagueCategory>("open");
  const [selected, setSelected] = useState<string[]>([]);
  const [replay, setReplay] = useState<ReplayTrack[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const categoryRows = rows.filter(entry => (entry.category ?? "open") === category);
  const { leaders, rows: ranked } = rankLeagueScoreboard(rows, task, category);
  const tasks = task === "overall" ? [...leagueTasks] : [task];
  const counts = Object.fromEntries(leagueTasks.map(d => [d, Math.max(1, ...categoryRows.filter(e => e.discipline === d).map(e => e.attempt))]));
  const selectedKey = selected.join("|");
  useEffect(() => {
    sequence.current++;
    setReplay([]);
    setLoading(false);
    setError("");
  }, [selectedKey]);
  useEffect(() => {
    const allowed = new Set(rows.filter(e => e.replay_available).map(e => e.id));
    setSelected(current => current.every(id => allowed.has(id)) ? current : current.filter(id => allowed.has(id)));
  }, [rows]);
  useEffect(() => () => { sequence.current++; }, []);
  function toggle(id: string) {
    setSelected(current => current.includes(id) ? current.filter(value => value !== id)
      : current.length < 4 ? [...current, id] : current);
  }
  async function openReplay() {
    const request = ++sequence.current;
    setLoading(true); setError(""); setReplay([]);
    try {
      const response = await client.rpc("league_replay_tracks", { entry_ids: selected });
      if (request !== sequence.current) return;
      if (response.error) throw response.error;
      const tracks = response.data as ReplayTrack[];
      if (!Array.isArray(tracks) || tracks.length !== selected.length || tracks.length > 4)
        throw new Error("One or more selected tracks are no longer available for replay. Refresh the scoreboard.");
      setReplay(selected.map(id => tracks.find(track => track.id === id)!));
    } catch (cause) {
      if (request === sequence.current) setError((cause as {message?: string}).message ?? "Replay could not load. Please retry.");
    } finally { if (request === sequence.current) setLoading(false); }
  }
  return <>
    <div className="league-section-top">
      <div><p className="league-eyebrow">THE NATIONAL PICTURE</p><h2>Round scoreboard</h2><p>{roundTitle}</p></div>
      <button className="league-secondary" onClick={onRefresh}>Refresh scoreboard ↻</button>
    </div>
    <div className="league-tabs league-category-tabs" role="tablist" aria-label="Competition category">
      {leagueCategories.map(value => <button key={value.value} role="tab" aria-selected={category === value.value}
        className={category === value.value ? "active" : ""} onClick={() => {
          sequence.current++; setCategory(value.value); setSelected([]); setReplay([]); setLoading(false); setError("");
        }}>{value.label}</button>)}
    </div>
    <p className="league-caption">{leagueCategories.find(value => value.value === category)!.description} Rankings and points are calculated within this category only.</p>
    <div className="league-tabs" role="tablist" aria-label="Scoreboard task">
      {(["overall", ...leagueTasks] as const).map(value => <button key={value} role="tab" aria-selected={task === value}
        className={task === value ? "active" : ""} onClick={() => setTask(value)}>{value === "overall" ? "Scoreboard" : value}</button>)}
    </div>
    <div className="league-replay-selection">
      <div><strong>{selected.length} / 4 tracks selected</strong><p className="league-caption">Select a score to compare approved flights. Tracks load only when you open replay.</p></div>
      <div className="league-review-actions">
        <button className="league-button" disabled={!selected.length || loading} onClick={() => void openReplay()}>{loading ? "Loading replay…" : `Replay selected (${selected.length}) ▶`}</button>
        <button className="league-secondary" disabled={!selected.length} onClick={() => setSelected([])}>Clear selection</button>
      </div>
    </div>
    {!categoryRows.length ? <div className="league-empty"><h3>A fresh scoreboard.</h3><p>Approved {leagueCategories.find(value => value.value === category)!.label} scores will appear here for this round.</p></div> :
      <div className="league-table-scroll" tabIndex={0} role="region" aria-label="Round scores, scroll horizontally for all attempts">
        <table className="league-scoreboard-table">
          <caption className="league-caption">Wind-corrected speed and distance · measured time · approved entries only</caption>
          <thead>
            <tr><th rowSpan={2} scope="col">Rank</th><th rowSpan={2} scope="col" className="league-scoreboard-name">Competitor</th>
              {tasks.map(d => <th key={d} scope="colgroup" colSpan={counts[d] + 1} className="league-task-group">{d} / {leagueTaskUnit(d)}</th>)}
              <th rowSpan={2} scope="col">{task === "overall" ? "Round points" : "Task points"}</th></tr>
            <tr>{tasks.map(d => <Fragment key={d}>{Array.from({length: counts[d]}, (_, i) => <th scope="col" key={i}>Jump {i + 1}</th>)}<th scope="col">Best / %</th></Fragment>)}</tr>
          </thead>
          <tbody>{ranked.map(pilot => <tr key={pilot.id}>
            <td>{pilot.rank}</td><th scope="row" className="league-scoreboard-name">{pilot.name}<small>{pilot.region}</small></th>
            {tasks.map(d => <Fragment key={d}>{Array.from({length: counts[d]}, (_, i) => {
              const entry = pilot.entries.find(e => e.discipline === d && e.attempt === i + 1);
              if (!entry) return <td key={i} className="league-no-score">—</td>;
              const value = leagueTaskValue(entry);
              const percent = leaders[d] > 0 ? 100 * value / leaders[d] : 0;
              const isBest = Math.abs(value - pilot.best[d]) < 0.000001;
              return <td key={i}><label className={`league-score-pick ${selected.includes(entry.id) ? "selected" : ""}`}>
                <input type="checkbox" checked={selected.includes(entry.id)} disabled={!entry.replay_available || (selected.length >= 4 && !selected.includes(entry.id))}
                  onChange={() => toggle(entry.id)} aria-label={`Replay ${pilot.name}, ${d}, jump ${i + 1}`} />
                <span><b>{value.toFixed(d === "time" ? 2 : 1)}</b><small>{percent.toFixed(1)}%{isBest ? " · Best" : ""}</small></span>
              </label></td>;
            })}<td className="league-best-score">{pilot.entries.some(e => e.discipline === d) ? pilot.points[d].toFixed(1) + "%" : "—"}</td></Fragment>)}
            <td className="league-round-total">{(task === "overall" ? pilot.total : pilot.points[task]).toFixed(1)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    <p className="league-caption">Best approved jump per task counts: up to 100 points per task and 300 per round. All attempts remain visible. Missing tasks score zero; equal scores share rank.</p>
    {error && <p className="league-notice" role="alert">{error}</p>}
    {replay.length > 0 && <Suspense fallback={<p>Opening replay…</p>}><LeagueReplay key={replay.map(r => r.id).join("|")} tracks={replay} /></Suspense>}
  </>;
}
