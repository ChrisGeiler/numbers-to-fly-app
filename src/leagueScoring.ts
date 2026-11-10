import { getDetectedJumpTrack, parseFlySightCsv } from "./gpsAnalysis.ts";
import type { GpsTrackPoint } from "./gpsAnalysis.ts";

export const LEAGUE_SCORING_VERSION = "pilot-v1";
export const LEAGUE_WIND_MODEL = "gfs_global";
export type LeagueWindLevel = { height: number; north: number; east: number };
export type LeagueWindSnapshot = {
  model: string;
  fetched_at: string;
  hours: { time: number; levels: LeagueWindLevel[] }[];
};

function crossAt(
  a: GpsTrackPoint,
  b: GpsTrackPoint,
  height: number,
): GpsTrackPoint {
  const f = (height - a.altitudeM) / (b.altitudeM - a.altitudeM);
  const mix = (x: number, y: number) => x + (y - x) * f;
  return {
    ...a,
    altitudeM: height,
    timestampMs: mix(a.timestampMs!, b.timestampMs!),
    lat: mix(a.lat, b.lat),
    lon: mix(a.lon, b.lon),
    velNMps: mix(a.velNMps, b.velNMps),
    velEMps: mix(a.velEMps, b.velEMps),
  };
}

export function leagueWindow(csv: string, ground: number) {
  if (!Number.isFinite(ground) || ground < -100 || ground > 3000)
    throw new Error("Check the drop zone elevation in metres MSL.");
  const parsed = parseFlySightCsv(csv);
  if (parsed.length < 20 || parsed.some((p) => p.timestampMs === null))
    throw new Error("A timestamped FlySight CSV is required.");
  const detected = getDetectedJumpTrack(parsed);
  if (!detected.isExitDetected)
    throw new Error(
      "No reliable aircraft exit was detected. This track needs review.",
    );
  const points = detected.jumpPoints;
  const top = ground + 2500,
    bottom = ground + 1500;
  const start = points.findIndex(
    (p, i) => i > 0 && points[i - 1].altitudeM > top && p.altitudeM <= top,
  );
  const end = points.findIndex(
    (p, i) =>
      i > start &&
      i > 0 &&
      points[i - 1].altitudeM > bottom &&
      p.altitudeM <= bottom,
  );
  if (start < 1 || end <= start)
    throw new Error("The complete 2,500–1,500 m AGL window is required.");
  // Validate the original boundary segments too; clipping must not hide gaps.
  validateLeagueWindow(points.slice(start - 1, end + 1));
  const entry = crossAt(points[start - 1], points[start], top);
  const exit = crossAt(points[end - 1], points[end], bottom);
  const window = [
    entry,
    ...points.slice(start, end).filter(point => point.timestampMs! > entry.timestampMs! && point.timestampMs! < exit.timestampMs!),
    exit,
  ];
  validateLeagueWindow(window);
  return window;
}

export function validateLeagueWindow(points: GpsTrackPoint[]) {
  if (points.length < 3) throw new Error("Insufficient GPS samples.");
  for (const [i, p] of points.entries()) {
    if (
      p.timestampMs === null ||
      !Number.isFinite(p.timestampMs) ||
      ![p.lat, p.lon, p.altitudeM, p.velNMps, p.velEMps].every(Number.isFinite)
    )
      throw new Error("Invalid GPS data.");
    if (p.lat < -45 || p.lat > -9 || p.lon < 110 || p.lon > 155)
      throw new Error("This pilot league accepts jumps in Australia only.");
    if (
      (p.hAccM ?? 0) > 25 ||
      (p.vAccM ?? 0) > 40 ||
      (p.speedAccuracyMps ?? 0) > 3
    )
      throw new Error("GPS accuracy is insufficient for automatic scoring.");
    if (
      i &&
      (p.timestampMs <= points[i - 1].timestampMs! ||
        p.timestampMs - points[i - 1].timestampMs! > 2000)
    )
      throw new Error(
        "GPS timestamps must increase with no gaps over two seconds.",
      );
  }
  const seconds = (points.at(-1)!.timestampMs! - points[0].timestampMs!) / 1000;
  if (seconds < 5 || seconds > 240)
    throw new Error("The scoring window duration needs manual review.");
}

function atHeight(levels: LeagueWindLevel[], height: number) {
  const sorted = [...levels].sort((a, b) => a.height - b.height);
  const lo = sorted.filter((l) => l.height <= height).at(-1),
    hi = sorted.find((l) => l.height >= height);
  if (!lo || !hi)
    throw new Error(
      "Archived wind data does not cover the complete scoring window.",
    );
  const f =
    hi.height === lo.height
      ? 0
      : (height - lo.height) / (hi.height - lo.height);
  return {
    north: lo.north + (hi.north - lo.north) * f,
    east: lo.east + (hi.east - lo.east) * f,
  };
}

export function scoreLeagueWindow(
  points: GpsTrackPoint[],
  snapshot: LeagueWindSnapshot,
) {
  validateLeagueWindow(points);
  if (snapshot.model !== LEAGUE_WIND_MODEL)
    throw new Error("The round requires the fixed GFS Global model.");
  const hours = [...snapshot.hours].sort((a, b) => a.time - b.time);
  const windAt = (p: GpsTrackPoint) => {
    const lo = hours.filter((h) => h.time <= p.timestampMs!).at(-1),
      hi = hours.find((h) => h.time >= p.timestampMs!);
    if (!lo || !hi)
      throw new Error("Archived winds do not cover the jump time.");
    const a = atHeight(lo.levels, p.altitudeM),
      b = atHeight(hi.levels, p.altitudeM);
    const f =
      hi.time === lo.time
        ? 0
        : (p.timestampMs! - lo.time) / (hi.time - lo.time);
    return {
      north: a.north + (b.north - a.north) * f,
      east: a.east + (b.east - a.east) * f,
    };
  };
  let north = 0,
    east = 0,
    windNorth = 0,
    windEast = 0;
  const origin = points[0],
    last = points.at(-1)!;
  // Ground displacement is the straight line between the interpolated boundaries.
  north = (((last.lat - origin.lat) * Math.PI) / 180) * 6371000;
  east =
    (((last.lon - origin.lon) * Math.PI) / 180) *
    6371000 *
    Math.cos((((last.lat + origin.lat) / 2) * Math.PI) / 180);
  const winds = points.map(windAt);
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].timestampMs! - points[i - 1].timestampMs!) / 1000;
    windNorth += ((winds[i - 1].north + winds[i].north) / 2) * dt;
    windEast += ((winds[i - 1].east + winds[i].east) / 2) * dt;
  }
  const time_s = (last.timestampMs! - origin.timestampMs!) / 1000;
  const raw_distance_m = Math.hypot(north, east);
  const corrected_distance_m = Math.hypot(north - windNorth, east - windEast);
  const result = {
    time_s,
    raw_distance_m,
    raw_speed_kmh: (raw_distance_m / time_s) * 3.6,
    corrected_distance_m,
    corrected_speed_kmh: (corrected_distance_m / time_s) * 3.6,
    jump_at: new Date(origin.timestampMs!).toISOString(),
    scoring_version: LEAGUE_SCORING_VERSION,
  };
  if (
    !Object.values(result).every(
      (v) => typeof v !== "number" || Number.isFinite(v),
    )
  )
    throw new Error("Scoring produced an invalid result.");
  return result;
}

export async function fetchLeagueWinds(
  points: GpsTrackPoint[],
  fetcher: typeof fetch = fetch,
): Promise<LeagueWindSnapshot> {
  const levels = [
    1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650,
    625, 600, 575, 550, 525, 500,
  ];
  const first = points[0],
    last = points.at(-1)!;
  const hour = (ms: number) => new Date(ms).toISOString().slice(0, 13) + ":00";
  const params = new URLSearchParams({
    latitude: String(first.lat),
    longitude: String(first.lon),
    models: LEAGUE_WIND_MODEL,
    hourly: levels
      .flatMap((p) => [
        `wind_speed_${p}hPa`,
        `wind_direction_${p}hPa`,
        `geopotential_height_${p}hPa`,
      ])
      .join(","),
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    timezone: "GMT",
    start_hour: hour(Math.floor(first.timestampMs! / 3600000) * 3600000),
    end_hour: hour(Math.ceil(last.timestampMs! / 3600000) * 3600000),
  });
  const response = await fetcher(
    `https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok)
    throw new Error(
      "Archived winds are unavailable. Retry later; the entry remains pending.",
    );
  const data = await response.json();
  if (!data.hourly?.time?.length)
    throw new Error("No archived wind data returned.");
  const hours = data.hourly.time.map((time: number, i: number) => ({
    time: time * 1000,
    levels: levels.flatMap((p) => {
      const height = data.hourly[`geopotential_height_${p}hPa`]?.[i];
      const speed = data.hourly[`wind_speed_${p}hPa`]?.[i];
      const direction = data.hourly[`wind_direction_${p}hPa`]?.[i];
      if (
        ![height, speed, direction].every(
          (v) => typeof v === "number" && Number.isFinite(v),
        ) ||
        speed < 0
      )
        return [];
      const angle = (direction * Math.PI) / 180;
      return [
        {
          height,
          north: -speed * Math.cos(angle),
          east: -speed * Math.sin(angle),
        },
      ];
    }),
  }));
  return {
    model: LEAGUE_WIND_MODEL,
    fetched_at: new Date().toISOString(),
    hours,
  };
}
