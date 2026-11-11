export const leagueTasks = ["distance", "speed", "time"] as const;
export type LeagueTask = typeof leagueTasks[number];
export type LeagueScoreboardEntry = {
  id: string;
  competitor_key: string;
  public_name: string;
  region: string;
  discipline: LeagueTask;
  attempt: number;
  replay_available: boolean;
  time_s: number;
  corrected_speed_kmh: number;
  corrected_distance_m: number;
  raw_speed_kmh: number;
  raw_distance_m: number;
};
export const leagueTaskValue = (entry: LeagueScoreboardEntry) => entry.discipline === "time"
  ? entry.time_s : entry.discipline === "speed" ? entry.corrected_speed_kmh : entry.corrected_distance_m;
export const leagueTaskUnit = (task: LeagueTask) => task === "time" ? "s" : task === "speed" ? "km/h" : "m";

export function rankLeagueScoreboard(entries: LeagueScoreboardEntry[], task: LeagueTask | "overall" = "overall") {
  const leaders = Object.fromEntries(leagueTasks.map(d => [d,
    Math.max(0, ...entries.filter(e => e.discipline === d).map(leagueTaskValue))]));
  const grouped = new Map<string, { id: string; name: string; region: string; entries: LeagueScoreboardEntry[] }>();
  for (const entry of entries) {
    const row = grouped.get(entry.competitor_key) ?? { id: entry.competitor_key, name: entry.public_name, region: entry.region, entries: [] };
    row.entries.push(entry);
    grouped.set(row.id, row);
  }
  const rows = [...grouped.values()].map(row => {
    const best = Object.fromEntries(leagueTasks.map(d => [d,
      Math.max(0, ...row.entries.filter(e => e.discipline === d).map(leagueTaskValue))]));
    const points = Object.fromEntries(leagueTasks.map(d => [d, leaders[d] > 0 ? 100 * best[d] / leaders[d] : 0]));
    const total = leagueTasks.reduce((sum, d) => sum + points[d], 0);
    return { ...row, best, points, total, sort: task === "overall" ? total : points[task] };
  }).sort((a, b) => b.sort - a.sort || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { leaders, rows: rows.map(row => ({ ...row, rank: rows.findIndex(r => Math.abs(r.sort - row.sort) < 0.000001) + 1 })) };
}
