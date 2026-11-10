import { leagueWindow, validateLeagueWindow } from "./leagueScoring.ts";
import type { GpsTrackPoint } from "./gpsAnalysis.ts";

// Local, provisional measurements. No coordinates leave the browser here.
export function measureLeagueUploadWindow(points: GpsTrackPoint[]) {
  validateLeagueWindow(points);
  const first = points[0],
    last = points.at(-1)!;
  const timeSeconds = (last.timestampMs! - first.timestampMs!) / 1000;
  const north = (((last.lat - first.lat) * Math.PI) / 180) * 6371000;
  const east =
    (((last.lon - first.lon) * Math.PI) / 180) *
    6371000 *
    Math.cos((((last.lat + first.lat) / 2) * Math.PI) / 180);
  const distanceMetres = Math.hypot(north, east);
  return {
    timeSeconds,
    distanceMetres,
    speedKmh: (distanceMetres / timeSeconds) * 3.6,
  };
}

export function calculateLeagueUploadScores(
  csv: string,
  groundElevation: number,
) {
  return measureLeagueUploadWindow(leagueWindow(csv, groundElevation));
}
