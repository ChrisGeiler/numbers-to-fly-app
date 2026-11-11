import { leagueWindow, scoreLeagueWindow, leagueWindAtPoint } from "./leagueScoring.ts";
import type { LeagueWindSnapshot } from "./leagueScoring.ts";

export type LeagueReplayPoint = {
  seconds: number;
  altitudeM: number;
  forwardM: number;
  lateralM: number;
  speedKmh: number;
};
export type LeagueReplayData = {
  version: 1;
  model: string;
  provider: string;
  points: LeagueReplayPoint[];
};

// Public replay contains relative flight geometry only: no original GPS,
// absolute timestamp, filename, account identifier or weather-location payload.
export function buildLeagueReplay(csv: string, ground: number, winds: LeagueWindSnapshot): LeagueReplayData {
  const points = leagueWindow(csv, ground);
  scoreLeagueWindow(points, winds); // Enforce exactly the authoritative score's validation.
  const origin = points[0];
  let windNorth = 0, windEast = 0;
  const samples = points.map((point, index) => {
    const wind = leagueWindAtPoint(point, winds);
    if (index) {
      const previous = points[index - 1];
      const previousWind = leagueWindAtPoint(previous, winds);
      const dt = (point.timestampMs! - previous.timestampMs!) / 1000;
      windNorth += (previousWind.north + wind.north) / 2 * dt;
      windEast += (previousWind.east + wind.east) / 2 * dt;
    }
    const north = (point.lat - origin.lat) * Math.PI / 180 * 6371000 - windNorth;
    const east = (point.lon - origin.lon) * Math.PI / 180 * 6371000 *
      Math.cos((point.lat + origin.lat) / 2 * Math.PI / 180) - windEast;
    return { seconds: (point.timestampMs! - origin.timestampMs!) / 1000,
      altitudeM: point.altitudeM - ground, north, east,
      speedKmh: Math.hypot(point.velNMps - wind.north, point.velEMps - wind.east) * 3.6 };
  });
  const last = samples.at(-1)!;
  const distance = Math.hypot(last.north, last.east);
  const headingNorth = distance ? last.north / distance : 1;
  const headingEast = distance ? last.east / distance : 0;
  return { version: 1, model: winds.model, provider: winds.provider ?? "open-meteo",
    points: samples.map(p => ({ seconds: p.seconds, altitudeM: p.altitudeM,
      forwardM: p.north * headingNorth + p.east * headingEast,
      lateralM: p.east * headingNorth - p.north * headingEast, speedKmh: p.speedKmh })) };
}

export function replayPointAt(points: LeagueReplayPoint[], seconds: number): LeagueReplayPoint {
  if (seconds <= points[0].seconds) return points[0];
  if (seconds >= points.at(-1)!.seconds) return points.at(-1)!;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].seconds <= seconds) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const f = (seconds - a.seconds) / (b.seconds - a.seconds);
  return { seconds, altitudeM: a.altitudeM + (b.altitudeM - a.altitudeM) * f,
    forwardM: a.forwardM + (b.forwardM - a.forwardM) * f,
    lateralM: a.lateralM + (b.lateralM - a.lateralM) * f,
    speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * f };
}
