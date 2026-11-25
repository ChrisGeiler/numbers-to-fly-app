import {degToRad} from "./flight/geo.ts";
import type {LatLon} from "./flight/geo.ts";
const DESIGNATED_LANE_HALF_WIDTH_M=300;
export type LanePenaltyEstimate = {
  severity: "none" | "ten" | "twenty" | "major";
  label: string;
  maxCenterlineDistanceM: number;
  maxOutsideLaneM: number;
};

export function distanceBetweenLatLonM(first: LatLon, second: LatLon) {
  const earthRadiusM = 6371000;
  const firstLatRad = degToRad(first.lat);
  const secondLatRad = degToRad(second.lat);
  const deltaLatRad = degToRad(second.lat - first.lat);
  const deltaLonRad = degToRad(second.lon - first.lon);
  const haversineValue =
    Math.sin(deltaLatRad / 2) ** 2 +
    Math.cos(firstLatRad) *
      Math.cos(secondLatRad) *
      Math.sin(deltaLonRad / 2) ** 2;
  const clampedValue = Math.min(1, Math.max(0, haversineValue));

  return (
    earthRadiusM *
    2 *
    Math.atan2(Math.sqrt(clampedValue), Math.sqrt(1 - clampedValue))
  );
}

function distanceFromLaneCenterlineM(
  point: LatLon,
  laneStart: LatLon,
  laneEnd: LatLon,
) {
  const earthRadiusM = 6371000;
  const referenceLatRad = degToRad((laneStart.lat + laneEnd.lat) / 2);
  const metresPerDegreeLat = (Math.PI / 180) * earthRadiusM;
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos(referenceLatRad);
  const laneX = (laneEnd.lon - laneStart.lon) * metresPerDegreeLon;
  const laneY = (laneEnd.lat - laneStart.lat) * metresPerDegreeLat;
  const pointX = (point.lon - laneStart.lon) * metresPerDegreeLon;
  const pointY = (point.lat - laneStart.lat) * metresPerDegreeLat;
  const laneLengthM = Math.hypot(laneX, laneY);

  if (laneLengthM < 1) {
    return null;
  }

  return Math.abs(pointX * laneY - pointY * laneX) / laneLengthM;
}

export function estimateLanePenalty(
  points: LatLon[],
  laneStart: LatLon,
  laneEnd: LatLon,
): LanePenaltyEstimate | null {
  const lateralDistances = points
    .map((point) => distanceFromLaneCenterlineM(point, laneStart, laneEnd))
    .filter((distance): distance is number => distance !== null);

  if (lateralDistances.length === 0) {
    return null;
  }

  const maxCenterlineDistanceM = Math.max(...lateralDistances);
  const maxOutsideLaneM = Math.max(
    0,
    maxCenterlineDistanceM - DESIGNATED_LANE_HALF_WIDTH_M,
  );

  if (maxOutsideLaneM <= 0) {
    return {
      severity: "none",
      label: "Inside the designated lane — no lane penalty indicated",
      maxCenterlineDistanceM,
      maxOutsideLaneM,
    };
  }

  if (maxOutsideLaneM < 150) {
    return {
      severity: "ten",
      label: "Estimated 10% result reduction",
      maxCenterlineDistanceM,
      maxOutsideLaneM,
    };
  }

  if (maxOutsideLaneM <= 300) {
    return {
      severity: "twenty",
      label: "Estimated 20% result reduction",
      maxCenterlineDistanceM,
      maxOutsideLaneM,
    };
  }

  return {
    severity: "major",
    label:
      "Estimated 50% reduction for a first infringement, or zero for a subsequent infringement",
    maxCenterlineDistanceM,
    maxOutsideLaneM,
  };
}
