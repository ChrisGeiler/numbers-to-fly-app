import type { GpsTrackPoint } from "./gpsAnalysis.ts";
import type { LeagueWindSnapshot } from "./leagueScoring.ts";

export async function fetchLocalLeagueWinds(points: GpsTrackPoint[], fetcher: typeof fetch = fetch): Promise<LeagueWindSnapshot> {
  const response = await fetcher("/api/league-winds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
    signal: AbortSignal.timeout(100000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Archived weather lookup failed.");
  return data;
}
