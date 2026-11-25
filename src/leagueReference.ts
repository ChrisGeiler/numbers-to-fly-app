export type LeagueReferencePoint = { name: string; lat: number; lon: number };

export function validLeagueReference(value: unknown): value is LeagueReferencePoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as LeagueReferencePoint;
  return Object.keys(point).length === 3 && typeof point.name === "string" &&
    point.name.trim().length >= 1 && point.name.trim().length <= 100 &&
    typeof point.lat === "number" && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 &&
    typeof point.lon === "number" && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180;
}
