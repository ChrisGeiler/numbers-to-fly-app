export type ForecastModel = "best_match" | "gfs_hrrr" | "gfs_global" | "ecmwf_ifs025" | "icon_global" | "icon_eu";
export const forecastModelLabels: Record<ForecastModel, string> = {
  best_match: "Automatic (provider-selected models)",
  gfs_hrrr: "HRRR (U.S. short-range)",
  gfs_global: "GFS (global)",
  ecmwf_ifs025: "ECMWF IFS 0.25° (global)",
  icon_global: "ICON Global (global)",
  icon_eu: "ICON-EU (Europe)",
};
export const pressureLevels = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650, 625, 600, 575, 550, 525, 500];
export type ForecastResponse = {
  elevation?: number;
  hourly?: Record<string, (number | null)[]>;
};
export function forecastUrl(lat: number, lon: number, model: ForecastModel, targetMs: number) {
  const hour = new Date(Math.round(targetMs / 3600000) * 3600000).toISOString().slice(0, 13) + ":00";
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), models: model,
    hourly: pressureLevels.flatMap(p => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]).join(","),
    wind_speed_unit: "kn", timeformat: "unixtime", timezone: "GMT",
    start_hour: hour, end_hour: hour,
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}
export function mapForecast(data: ForecastResponse, targetMs: number, altitudesAgl: number[]) {
  const hourly = data.hourly;
  if (!hourly?.time?.length || !Number.isFinite(data.elevation)) throw new Error("Forecast time or ground elevation is unavailable.");
  const index = hourly.time.findIndex(t => typeof t === "number" && Math.abs(t * 1000 - targetMs) <= 1800000);
  if (index < 0) throw new Error("The selected forecast hour is unavailable. Choose a closer time.");
  const ground = data.elevation!;
  const levels = pressureLevels.flatMap(p => {
    const height = hourly[`geopotential_height_${p}hPa`]?.[index];
    const speed = hourly[`wind_speed_${p}hPa`]?.[index];
    const direction = hourly[`wind_direction_${p}hPa`]?.[index];
    if (typeof height !== "number" || typeof speed !== "number" || typeof direction !== "number" || ![height, speed, direction].every(Number.isFinite) || speed < 0 || height <= ground) return [];
    const angle = direction * Math.PI / 180;
    return [{ height, u: -speed * Math.sin(angle), v: -speed * Math.cos(angle) }];
  }).sort((a, b) => a.height - b.height);
  const winds = altitudesAgl.map(altitudeM => {
    const height = altitudeM + ground;
    const lower = levels.filter(l => l.height <= height).at(-1);
    const upper = levels.find(l => l.height >= height);
    if (!lower || !upper) throw new Error(`No wind coverage at ${altitudeM} m AGL. Choose another model or time.`);
    const fraction = upper.height === lower.height ? 0 : (height - lower.height) / (upper.height - lower.height);
    const u = lower.u + (upper.u - lower.u) * fraction;
    const v = lower.v + (upper.v - lower.v) * fraction;
    return { altitudeM, speedKt: String(Math.round(Math.hypot(u, v))), directionFromDeg: String(Math.round((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360) % 360) };
  });
  return { winds, validTimeMs: hourly.time[index]! * 1000, groundElevationM: ground,
    minAltitudeAgl: Math.round(levels[0].height - ground), maxAltitudeAgl: Math.round(levels.at(-1)!.height - ground) };
}
