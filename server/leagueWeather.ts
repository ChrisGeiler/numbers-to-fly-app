// Server-only: never import this module into the browser bundle.
import { fetchLeagueWinds, scoreLeagueWindow, validateLeagueWindow, LEAGUE_WIND_MODEL } from "../src/leagueScoring.ts";
import type { LeagueWindSnapshot } from "../src/leagueScoring.ts";
import type { GpsTrackPoint } from "../src/gpsAnalysis.ts";

type Credentials = { username?: string; password?: string };
const levels = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500];

export async function fetchMeteomaticsWinds(points: GpsTrackPoint[], credentials: Credentials, fetcher: typeof fetch = fetch): Promise<LeagueWindSnapshot> {
  if (!credentials.username || !credentials.password)
    throw new Error("Meteomatics fallback is not configured. Historical upper-air API access is required.");
  const start = Math.floor(points[0].timestampMs! / 3600000) * 3600000;
  const end = Math.ceil(points.at(-1)!.timestampMs! / 3600000) * 3600000;
  const parameters = levels.flatMap(p => [`wind_speed_${p}hPa:ms`, `wind_dir_${p}hPa:d`, `geopotential_height_${p}hPa:m`]);
  const url = `https://api.meteomatics.com/${new Date(start).toISOString()}--${new Date(end).toISOString()}:PT1H/${parameters.join(",")}/${points[0].lat},${points[0].lon}/json?source=ncep-gfs&on_invalid=fail&timeout=40`;
  const response = await fetcher(url, {
    headers: { Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` },
    signal: AbortSignal.timeout(45000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Meteomatics returned HTTP ${response.status}. Check account access to historical upper-air GFS data.`);
  // Only parse expected weather fields; never return provider account metadata.
  const body = await response.json() as { status?: string; data?: { parameter: string; coordinates?: { lat: number; lon: number; dates?: { date: string; value: number }[] }[] }[] };
  if (body.status !== "OK" || !Array.isArray(body.data)) throw new Error("Meteomatics returned no usable wind data.");
  const values = new Map<string, Map<number, number>>();
  for (const field of body.data) {
    const coordinate = field.coordinates?.[0];
    if (!parameters.includes(field.parameter) || !coordinate ||
      !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lon) ||
      Math.abs(coordinate.lat - points[0].lat) > 0.001 || Math.abs(coordinate.lon - points[0].lon) > 0.001) continue;
    const dates = new Map<number, number>();
    for (const sample of coordinate.dates ?? []) {
      if (typeof sample.value === "number" && Number.isFinite(sample.value) && sample.value !== -999)
        dates.set(Date.parse(sample.date), sample.value);
    }
    values.set(field.parameter, dates);
  }
  const hours: LeagueWindSnapshot["hours"] = [];
  for (let time = start; time <= end; time += 3600000) {
    hours.push({ time, levels: levels.flatMap(p => {
      const speed = values.get(`wind_speed_${p}hPa:ms`)?.get(time);
      const direction = values.get(`wind_dir_${p}hPa:d`)?.get(time);
      const height = values.get(`geopotential_height_${p}hPa:m`)?.get(time);
      if (speed === undefined || direction === undefined || height === undefined || speed < 0 || direction < 0 || direction > 360) return [];
      const angle = direction * Math.PI / 180;
      return [{ height, north: -speed * Math.cos(angle), east: -speed * Math.sin(angle) }];
    }) });
  }
  return { model: LEAGUE_WIND_MODEL, provider: "meteomatics", fetched_at: new Date().toISOString(), hours };
}

export function createLeagueWeatherService(credentials: Credentials, fetcher: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; value: LeagueWindSnapshot }>();
  const pending = new Map<string, Promise<LeagueWindSnapshot>>();
  return async (points: GpsTrackPoint[]) => {
    validateLeagueWindow(points);
    const key = JSON.stringify([points[0].lat, points[0].lon,
      Math.floor(points[0].timestampMs! / 3600000), Math.ceil(points.at(-1)!.timestampMs! / 3600000)]);
    const saved = cache.get(key);
    if (saved && saved.expires > Date.now()) {
      scoreLeagueWindow(points, saved.value);
      return saved.value;
    }
    let job = pending.get(key);
    if (!job) {
      job = (async () => {
        let winds: LeagueWindSnapshot;
        try {
          winds = await fetchLeagueWinds(points, fetcher);
          scoreLeagueWindow(points, winds);
        } catch (error) {
          const reason = error instanceof Error && error.name === "TimeoutError"
            ? "Open-Meteo exceeded the 45-second weather timeout."
            : "Open-Meteo was unavailable or returned incomplete winds.";
          try {
            winds = await fetchMeteomaticsWinds(points, credentials, fetcher);
            winds.fallback_reason = reason;
            scoreLeagueWindow(points, winds);
          } catch (fallbackError) {
            throw new Error(`${reason} ${fallbackError instanceof Error ? fallbackError.message : "Meteomatics fallback failed."}`);
          }
        }
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, { value: winds, expires: Date.now() + 3600000 });
        return winds;
      })();
      pending.set(key, job);
      void job.finally(() => pending.delete(key)).catch(() => {});
    }
    const result = await job;
    scoreLeagueWindow(points, result);
    return result;
  };
}
