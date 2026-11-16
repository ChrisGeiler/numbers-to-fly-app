import type { GpsTrackPoint } from './gpsAnalysis';
import { degToRad, normalizeDeg, signedAngleDeg } from './flight/geo';
export type WindLayer = {
  altitudeM: number;
  directionFromDeg: string;
  speedKt: string;
};

export function numberFromInput(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function interpolateDirection(
  altitudeM: number,
  altitudeLevels: number[],
  directionsByAltitude: Record<string, number>
): number {
  const sortedAltitudes = [...altitudeLevels].sort((a, b) => a - b);

  const exactValue = directionsByAltitude[String(altitudeM)];
  if (exactValue !== undefined) return normalizeDeg(exactValue);

  const lowerAltitudes = sortedAltitudes.filter((alt) => alt <= altitudeM);
  const upperAltitudes = sortedAltitudes.filter((alt) => alt >= altitudeM);

  const lowerAltitude = lowerAltitudes[lowerAltitudes.length - 1];
  const upperAltitude = upperAltitudes[0];

  if (lowerAltitude === undefined && upperAltitude === undefined) {
    throw new Error("No altitude data available.");
  }

  if (lowerAltitude === undefined) {
    return normalizeDeg(directionsByAltitude[String(upperAltitude)]);
  }

  if (upperAltitude === undefined) {
    return normalizeDeg(directionsByAltitude[String(lowerAltitude)]);
  }

  if (lowerAltitude === upperAltitude) {
    return normalizeDeg(directionsByAltitude[String(lowerAltitude)]);
  }

  const lowerDirection = directionsByAltitude[String(lowerAltitude)];
  const upperDirection = directionsByAltitude[String(upperAltitude)];
  const progress = (altitudeM - lowerAltitude) / (upperAltitude - lowerAltitude);
  const shortestDifference = signedAngleDeg(lowerDirection, upperDirection);

  return normalizeDeg(lowerDirection + shortestDifference * progress);
}

export function interpolateNumber(
  altitudeM: number,
  altitudeLevels: number[],
  valuesByAltitude: Record<string, number>
): number {
  const sortedAltitudes = [...altitudeLevels].sort((a, b) => a - b);

  const exactValue = valuesByAltitude[String(altitudeM)];
  if (exactValue !== undefined) return exactValue;

  const lowerAltitudes = sortedAltitudes.filter((alt) => alt <= altitudeM);
  const upperAltitudes = sortedAltitudes.filter((alt) => alt >= altitudeM);

  const lowerAltitude = lowerAltitudes[lowerAltitudes.length - 1];
  const upperAltitude = upperAltitudes[0];

  if (lowerAltitude === undefined && upperAltitude === undefined) {
    throw new Error("No altitude data available.");
  }

  if (lowerAltitude === undefined) return valuesByAltitude[String(upperAltitude)];
  if (upperAltitude === undefined) return valuesByAltitude[String(lowerAltitude)];
  if (lowerAltitude === upperAltitude)
    return valuesByAltitude[String(lowerAltitude)];

  const lowerValue = valuesByAltitude[String(lowerAltitude)];
  const upperValue = valuesByAltitude[String(upperAltitude)];
  const progress = (altitudeM - lowerAltitude) / (upperAltitude - lowerAltitude);

  return lowerValue + (upperValue - lowerValue) * progress;
}

export function getDisplayHorizontalSpeedMps(
  point: GpsTrackPoint,
  winds: WindLayer[],
  useCorrected: boolean
) {
  return useCorrected
    ? getWindCorrectedHorizontalSpeedMps(point, winds)
    : point.horizontalSpeedMps;
}

export function getWindCorrectedHorizontalSpeedMps(
  point: GpsTrackPoint,
  winds: WindLayer[]
) {
  if (winds.length === 0) {
    return point.horizontalSpeedMps;
  }

  const windAltitudes = winds.map((wind) => wind.altitudeM);

  const windDirectionsByAltitude = Object.fromEntries(
    winds.map((wind) => [
      String(wind.altitudeM),
      numberFromInput(wind.directionFromDeg, 0),
    ])
  );

  const windSpeedsByAltitude = Object.fromEntries(
    winds.map((wind) => [
      String(wind.altitudeM),
      numberFromInput(wind.speedKt, 0),
    ])
  );

  const windDirectionFromDeg = interpolateDirection(
    point.altitudeM,
    windAltitudes,
    windDirectionsByAltitude
  );

  const windSpeedKt = interpolateNumber(
    point.altitudeM,
    windAltitudes,
    windSpeedsByAltitude
  );

  const windTowardDeg = normalizeDeg(windDirectionFromDeg + 180);
  const windSpeedMps = windSpeedKt * 0.514444;
  const windTowardRad = degToRad(windTowardDeg);

  const windNorthMps = Math.cos(windTowardRad) * windSpeedMps;
  const windEastMps = Math.sin(windTowardRad) * windSpeedMps;

  const airNorthMps = point.velNMps - windNorthMps;
  const airEastMps = point.velEMps - windEastMps;

  return Math.sqrt(airNorthMps * airNorthMps + airEastMps * airEastMps);
}

export function getDisplayTotalSpeedMps(
  point: GpsTrackPoint,
  winds: WindLayer[],
  useCorrected: boolean
) {
  const horizontalSpeedMps = getDisplayHorizontalSpeedMps(
    point,
    winds,
    useCorrected
  );

  return Math.sqrt(
    horizontalSpeedMps * horizontalSpeedMps +
      point.verticalSpeedMps * point.verticalSpeedMps
  );
}

export function getDisplayGlideRatio(
  point: GpsTrackPoint,
  winds: WindLayer[],
  useCorrected: boolean
) {
  if (point.verticalSpeedMps <= 0) {
    return null;
  }

  return (
    getDisplayHorizontalSpeedMps(point, winds, useCorrected) /
    point.verticalSpeedMps
  );
}
