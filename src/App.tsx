import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { supabase } from "./supabase";
import type { Session } from "@supabase/supabase-js";
import {
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip as LeafletTooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import Fuse from "fuse.js";
import { faiRuleSections } from "./faiPerformanceRules.ts";
import {
  bearingBetweenPointsDeg,
  buildLanePolygon,
  buildLaneStripPolygon,
  calculateDropPoint,
  degToRad,
  destinationPoint,
  nmToMetres,
  normalizeDeg,
  signedAngleDeg,
} from "./flight/geo";
import type { LatLon } from "./flight/geo";
import {
  estimateDzElevationM,
  formatNumber,
  getDetectedJumpTrack,
  getLast800mWindowPoints,
  getPointDiveAngleDeg,
  getScoringWindowResult,
  getTop100mFlareResult,
  getTrackDistanceM,
  getValidatedJumpTrack,
  getValidationStartPoint,
  getWindowTrackPoints,
  GPS_SAMPLE_PERIOD_SECONDS,
  metresPerSecondToKmh,
  parseFlySightCsv,
  trimTrackAfterLanding,
  trimTrackForAnalysis,
} from "./gpsAnalysis";
import type { GpsTrackPoint } from "./gpsAnalysis";
import L from "leaflet";
import maplibregl from "maplibre-gl";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";

type GoogleCredentialResponse = {
  credential?: string;
};

type GoogleIdentityServices = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        nonce?: string;
        use_fedcm_for_prompt?: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: {
          type: "standard";
          theme: "outline";
          size: "large";
          shape: "rectangular";
          text: "continue_with";
          logo_alignment: "left";
          width: number;
        },
      ) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ??
  "287085993983-2l0111ru255rff5rjeaa7fimprq6fe0a.apps.googleusercontent.com";

let googleIdentityScriptPromise: Promise<GoogleIdentityServices> | null = null;

function loadGoogleIdentityServices() {
  if (window.google) {
    return Promise.resolve(window.google);
  }

  if (googleIdentityScriptPromise) {
    return googleIdentityScriptPromise;
  }

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    const script = existingScript ?? document.createElement("script");

    const handleLoad = () => {
      if (window.google) {
        resolve(window.google);
      } else {
        googleIdentityScriptPromise = null;
        reject(new Error("Google sign-in did not load correctly."));
      }
    };

    const handleError = () => {
      googleIdentityScriptPromise = null;
      reject(new Error("Google sign-in could not be loaded."));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existingScript) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return googleIdentityScriptPromise;
}

async function createGoogleSignInNonce() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...randomBytes));
  const encodedNonce = new TextEncoder().encode(nonce);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encodedNonce);
  const hashedNonce = Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return { nonce, hashedNonce };
}

type AppMode = "phone" | "desktop";
type AppPage =
  | "landing"
  | "find"
  | "fly"
  | "config"
  | "lane"
  | "rules"
  | "gps";
const APP_PAGE_STORAGE_KEY = "numbers-to-fly:active-page";
const REFERENCE_POINT_GROUPS_STORAGE_KEY =
  "numbers-to-fly:reference-point-groups";
const MAX_REFERENCE_POINTS_PER_GROUP = 12;
const ANALYZER_REFERENCE_GROUP_MATCH_RADIUS_M = 5 * 1852;
const DESIGNATED_LANE_HALF_WIDTH_M = 300;
const APP_PAGES: readonly AppPage[] = [
  "landing",
  "find",
  "fly",
  "config",
  "lane",
  "rules",
  "gps",
];

function getSavedAppPage(): AppPage {
  try {
    const savedPage = window.sessionStorage.getItem(APP_PAGE_STORAGE_KEY);
    return APP_PAGES.includes(savedPage as AppPage)
      ? (savedPage as AppPage)
      : "landing";
  } catch {
    return "landing";
  }
}

type SavedReferencePoint = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

type SavedReferencePointGroup = {
  id: string;
  name: string;
  points: SavedReferencePoint[];
};

type SavedReferencePointStore = {
  version: 1;
  activeGroupId: string | null;
  groups: SavedReferencePointGroup[];
};

const NO_SAVED_REFERENCE_POINTS: SavedReferencePoint[] = [];
const NO_TRACK_POINTS: GpsTrackPoint[] = [];

function createReferencePointId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseSavedReferencePoint(value: unknown): SavedReferencePoint | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const point = value as Record<string, unknown>;

  if (
    typeof point.id !== "string" ||
    typeof point.name !== "string" ||
    !point.name.trim() ||
    typeof point.lat !== "number" ||
    !Number.isFinite(point.lat) ||
    point.lat < -90 ||
    point.lat > 90 ||
    typeof point.lon !== "number" ||
    !Number.isFinite(point.lon) ||
    point.lon < -180 ||
    point.lon > 180
  ) {
    return null;
  }

  return {
    id: point.id,
    name: point.name.trim(),
    lat: point.lat,
    lon: point.lon,
  };
}

function getSavedReferencePointStore(): SavedReferencePointStore {
  const emptyStore: SavedReferencePointStore = {
    version: 1,
    activeGroupId: null,
    groups: [],
  };

  try {
    const rawStore = window.localStorage.getItem(
      REFERENCE_POINT_GROUPS_STORAGE_KEY,
    );

    if (!rawStore) {
      return emptyStore;
    }

    const parsedStore = JSON.parse(rawStore) as unknown;

    if (!parsedStore || typeof parsedStore !== "object") {
      return emptyStore;
    }

    const candidate = parsedStore as Record<string, unknown>;

    if (candidate.version !== 1 || !Array.isArray(candidate.groups)) {
      return emptyStore;
    }

    const groups = candidate.groups.flatMap((value) => {
      if (!value || typeof value !== "object") {
        return [];
      }

      const group = value as Record<string, unknown>;

      if (
        typeof group.id !== "string" ||
        typeof group.name !== "string" ||
        !group.name.trim() ||
        !Array.isArray(group.points)
      ) {
        return [];
      }

      const points = group.points
        .map(parseSavedReferencePoint)
        .filter((point): point is SavedReferencePoint => point !== null)
        .slice(0, MAX_REFERENCE_POINTS_PER_GROUP);

      return [
        {
          id: group.id,
          name: group.name.trim(),
          points,
        },
      ];
    });

    const requestedActiveGroupId =
      typeof candidate.activeGroupId === "string"
        ? candidate.activeGroupId
        : null;
    const activeGroupId = groups.some(
      (group) => group.id === requestedActiveGroupId,
    )
      ? requestedActiveGroupId
      : groups[0]?.id ?? null;

    return {
      version: 1,
      activeGroupId,
      groups,
    };
  } catch {
    return emptyStore;
  }
}

type LanePenaltyEstimate = {
  severity: "none" | "ten" | "twenty" | "major";
  label: string;
  maxCenterlineDistanceM: number;
  maxOutsideLaneM: number;
};

function distanceBetweenLatLonM(first: LatLon, second: LatLon) {
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

function estimateLanePenalty(
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

type TaskMode = "time" | "distance" | "speed";
type LogbookTrackType = TaskMode | "non-comp";
type TrackAssessorAccessState = "checking" | "allowed" | "denied";
const ASSESSOR_ZERO_WIND_TARGETS = {
  speedKmh: 300,
  timeSeconds: 100,
  distanceM: 4500,
  entryGlideRatio: 1,
  diveAngleMinDeg: 70,
  diveAngleMaxDeg: 82,
  verticalSpeedKmh: 300,
} as const;
type EnergyManagementRating = "good" | "mixed" | "poor" | "insufficient";
type EnergyManagementSample = {
  totalSpeedKmh: number;
  diveAngleDeg: number;
  glideRatio: number | null;
};
type EnergyManagementResult = {
  rating: EnergyManagementRating;
  label: string;
  summary: string;
  durationSeconds: number;
  speedRetentionPercent: number | null;
  speedBleedPercentPerSecond: number | null;
  speedVariationPercent: number | null;
  diveAngleVariationDeg: number | null;
  glideRatioVariationPercent: number | null;
  meaningfulPitchReversals: number;
};
type FlightTransitionResult = {
  rating: EnergyManagementRating;
  label: string;
  summary: string;
  durationSeconds: number;
  speedVariationPercent: number | null;
  diveAngleVariationDeg: number | null;
  glideRatioVariationPercent: number | null;
  meaningfulPitchReversals: number;
  diveAngleChangeDeg: number | null;
};
type TargetAdherenceSample = {
  actualValue: number;
  targetValue: number;
};
type TargetAdherenceResult = {
  rating: EnergyManagementRating;
  label: string;
  summary: string;
  targetLabel: string;
  toleranceLabel: string;
  averageTarget: number;
  averageActual: number;
  meanAbsoluteError: number;
  averageDifference: number;
  withinTargetPercent: number;
};
type TrackAssessment = {
  headline: string;
  summary: string;
  strengths: string[];
  improvement: string;
  evidence: string[];
  targetAdherence: TargetAdherenceResult | null;
  flightTransition: FlightTransitionResult | null;
  energyManagement: EnergyManagementResult | null;
};
type TrackAssessmentMetrics = {
  task: TaskMode;
  timeSeconds: number;
  distanceM: number;
  speedKmh: number | null;
  peakDiveAngleDeg: number | null;
  peakVerticalSpeedKmh: number | null;
  peakTotalSpeedKmh: number | null;
  entryGlideRatio: number | null;
  exitGlideRatio: number | null;
  flareStartAltitudeM: number | null;
  flareAltitudeGainM: number | null;
  last800mHorizontalSpeedKmh: number | null;
  last800mGlideRatio: number | null;
  lineEfficiencyPercent: number | null;
  tailwindKts: number | null;
  usesCalculatedAirspeed: boolean;
  targetAdherence: TargetAdherenceResult | null;
  flightTransition: FlightTransitionResult | null;
  energyManagement: EnergyManagementResult | null;
};

function averageFiniteNumbers(values: Array<number | null>) {
  const finiteValues = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );

  return finiteValues.length > 0
    ? finiteValues.reduce((total, value) => total + value, 0) /
        finiteValues.length
    : null;
}

function getLinearResidualStandardDeviation(values: number[]) {
  if (values.length < 3) {
    return null;
  }

  const averageIndex = (values.length - 1) / 2;
  const averageValue = averageFiniteNumbers(values);

  if (averageValue === null) {
    return null;
  }

  let covariance = 0;
  let indexVariance = 0;

  values.forEach((value, index) => {
    covariance += (index - averageIndex) * (value - averageValue);
    indexVariance += (index - averageIndex) ** 2;
  });

  const slope = indexVariance > 0 ? covariance / indexVariance : 0;
  const intercept = averageValue - slope * averageIndex;
  const meanSquaredResidual = averageFiniteNumbers(
    values.map((value, index) => {
      const residual = value - (intercept + slope * index);
      return residual ** 2;
    }),
  );

  return meanSquaredResidual === null ? null : Math.sqrt(meanSquaredResidual);
}

function countMeaningfulPitchReversals(
  diveAnglesDeg: number[],
  thresholdDeg = 2.5,
) {
  if (diveAnglesDeg.length < 3) {
    return 0;
  }

  let direction: -1 | 0 | 1 = 0;
  let extremeAngleDeg = diveAnglesDeg[0];
  let directionChanges = 0;

  diveAnglesDeg.slice(1).forEach((diveAngleDeg) => {
    if (direction >= 0) {
      if (diveAngleDeg > extremeAngleDeg) {
        extremeAngleDeg = diveAngleDeg;
      } else if (extremeAngleDeg - diveAngleDeg >= thresholdDeg) {
        directionChanges += 1;
        direction = -1;
        extremeAngleDeg = diveAngleDeg;
      }
    } else if (diveAngleDeg < extremeAngleDeg) {
      extremeAngleDeg = diveAngleDeg;
    } else if (diveAngleDeg - extremeAngleDeg >= thresholdDeg) {
      directionChanges += 1;
      direction = 1;
      extremeAngleDeg = diveAngleDeg;
    }
  });

  return Math.max(0, directionChanges - 1);
}

function analyzeEnergyManagement(
  samples: EnergyManagementSample[],
  durationSeconds: number,
): EnergyManagementResult {
  const insufficientResult: EnergyManagementResult = {
    rating: "insufficient",
    label: "Not enough post-flare data",
    summary:
      "The assessor needs at least 12 seconds of stable post-flare flight before judging energy management.",
    durationSeconds,
    speedRetentionPercent: null,
    speedBleedPercentPerSecond: null,
    speedVariationPercent: null,
    diveAngleVariationDeg: null,
    glideRatioVariationPercent: null,
    meaningfulPitchReversals: 0,
  };

  if (samples.length < 10 || durationSeconds < 12) {
    return insufficientResult;
  }

  const segmentSampleCount = Math.max(3, Math.floor(samples.length * 0.1));
  const startSpeedKmh = averageFiniteNumbers(
    samples
      .slice(0, segmentSampleCount)
      .map((sample) => sample.totalSpeedKmh),
  );
  const endSpeedKmh = averageFiniteNumbers(
    samples
      .slice(-segmentSampleCount)
      .map((sample) => sample.totalSpeedKmh),
  );
  const averageSpeedKmh = averageFiniteNumbers(
    samples.map((sample) => sample.totalSpeedKmh),
  );
  const speedResidualStandardDeviation =
    getLinearResidualStandardDeviation(
      samples.map((sample) => sample.totalSpeedKmh),
    );
  const diveAngleResidualStandardDeviation =
    getLinearResidualStandardDeviation(
      samples.map((sample) => sample.diveAngleDeg),
    );
  const finiteGlideRatios = samples
    .map((sample) => sample.glideRatio)
    .filter(
      (glideRatio): glideRatio is number =>
        glideRatio !== null && Number.isFinite(glideRatio),
    );
  const averageGlideRatio = averageFiniteNumbers(finiteGlideRatios);
  const glideRatioResidualStandardDeviation =
    getLinearResidualStandardDeviation(finiteGlideRatios);

  if (
    startSpeedKmh === null ||
    endSpeedKmh === null ||
    startSpeedKmh <= 0 ||
    averageSpeedKmh === null ||
    averageSpeedKmh <= 0
  ) {
    return insufficientResult;
  }

  const speedRetentionPercent = (endSpeedKmh / startSpeedKmh) * 100;
  const speedBleedPercentPerSecond =
    (Math.max(0, startSpeedKmh - endSpeedKmh) / startSpeedKmh / durationSeconds) *
    100;
  const speedVariationPercent =
    speedResidualStandardDeviation === null
      ? null
      : (speedResidualStandardDeviation / averageSpeedKmh) * 100;
  const glideRatioVariationPercent =
    glideRatioResidualStandardDeviation === null ||
    averageGlideRatio === null ||
    averageGlideRatio === 0
      ? null
      : (glideRatioResidualStandardDeviation / Math.abs(averageGlideRatio)) *
        100;
  const meaningfulPitchReversals = countMeaningfulPitchReversals(
    samples.map((sample) => sample.diveAngleDeg),
  );
  const diveAngleVariationDeg = diveAngleResidualStandardDeviation;
  const speedTrendIsSlow = speedBleedPercentPerSecond <= 0.6;
  const speedTraceIsSmooth =
    speedVariationPercent !== null && speedVariationPercent <= 4.5;
  const pitchTraceIsSmooth =
    diveAngleVariationDeg !== null &&
    diveAngleVariationDeg <= 2.5 &&
    meaningfulPitchReversals <= 3;
  const glideRatioTraceIsSmooth =
    glideRatioVariationPercent !== null && glideRatioVariationPercent <= 15;
  const tracesAreSmooth =
    speedTraceIsSmooth && pitchTraceIsSmooth && glideRatioTraceIsSmooth;
  const tracesAreGenerallyControlled =
    speedVariationPercent !== null &&
    speedVariationPercent <= 6.5 &&
    diveAngleVariationDeg !== null &&
    diveAngleVariationDeg <= 4.5 &&
    meaningfulPitchReversals <= 5 &&
    glideRatioVariationPercent !== null &&
    glideRatioVariationPercent <= 22;
  const energyManagementIsGood =
    tracesAreSmooth && speedTrendIsSlow;
  const energyManagementIsMixed =
    tracesAreSmooth || tracesAreGenerallyControlled;

  const issues: string[] = [];

  if (!speedTrendIsSlow) {
    issues.push("total speed bled away quickly despite the overall trend");
  }

  if (!speedTraceIsSmooth) {
    issues.push("speed moved up and down around its overall trend");
  }

  if (!pitchTraceIsSmooth) {
    issues.push(
      meaningfulPitchReversals > 3
        ? `${meaningfulPitchReversals} meaningful dive-angle reversals were detected`
        : "dive angle varied excessively",
    );
  }

  if (!glideRatioTraceIsSmooth) {
    issues.push("GR varied rather than changing progressively");
  }

  if (energyManagementIsGood) {
    return {
      rating: "good",
      label: "Good energy management",
      summary: `After the flare, the speed, dive-angle and GR traces stayed smooth and changed progressively. Total speed bled at ${formatNumber(speedBleedPercentPerSecond, 2)}% per second with ${formatNumber(speedRetentionPercent, 0)}% retained, and no repeated pitch oscillation was detected.`,
      durationSeconds,
      speedRetentionPercent,
      speedBleedPercentPerSecond,
      speedVariationPercent,
      diveAngleVariationDeg,
      glideRatioVariationPercent,
      meaningfulPitchReversals,
    };
  }

  const issueSummary =
    issues.length > 0 ? issues.join("; ") : "the post-flare trend was uneven";

  return {
    rating: energyManagementIsMixed ? "mixed" : "poor",
    label: energyManagementIsMixed
      ? "Generally controlled energy"
      : "Inconsistent energy management",
    summary: energyManagementIsMixed
      ? `The post-flare traces were generally controlled, but ${issueSummary}. The overall trend remained usable without the consistency of the labelled good runs.`
      : `Energy was not maintained cleanly after the flare: ${issueSummary}. The assessor only labels this inconsistent when the post-flare traces show genuine variation around their overall trend.`,
    durationSeconds,
    speedRetentionPercent,
    speedBleedPercentPerSecond,
    speedVariationPercent,
    diveAngleVariationDeg,
    glideRatioVariationPercent,
    meaningfulPitchReversals,
  };
}

function analyzeFlightTransition(
  samples: EnergyManagementSample[],
  durationSeconds: number,
): FlightTransitionResult {
  const insufficientResult: FlightTransitionResult = {
    rating: "insufficient",
    label: "Not enough transition data",
    summary:
      "The assessor could not isolate enough of the post-flare transition to judge it confidently.",
    durationSeconds,
    speedVariationPercent: null,
    diveAngleVariationDeg: null,
    glideRatioVariationPercent: null,
    meaningfulPitchReversals: 0,
    diveAngleChangeDeg: null,
  };

  if (samples.length < 4 || durationSeconds < 4) {
    return insufficientResult;
  }

  const averageSpeedKmh = averageFiniteNumbers(
    samples.map((sample) => sample.totalSpeedKmh),
  );
  const speedResidualStandardDeviation = getLinearResidualStandardDeviation(
    samples.map((sample) => sample.totalSpeedKmh),
  );
  const diveAngleVariationDeg = getLinearResidualStandardDeviation(
    samples.map((sample) => sample.diveAngleDeg),
  );
  const finiteGlideRatios = samples
    .map((sample) => sample.glideRatio)
    .filter(
      (glideRatio): glideRatio is number =>
        glideRatio !== null && Number.isFinite(glideRatio),
    );
  const averageGlideRatio = averageFiniteNumbers(finiteGlideRatios);
  const glideRatioResidualStandardDeviation =
    getLinearResidualStandardDeviation(finiteGlideRatios);
  const speedVariationPercent =
    speedResidualStandardDeviation === null ||
    averageSpeedKmh === null ||
    averageSpeedKmh <= 0
      ? null
      : (speedResidualStandardDeviation / averageSpeedKmh) * 100;
  const glideRatioVariationPercent =
    glideRatioResidualStandardDeviation === null ||
    averageGlideRatio === null ||
    Math.abs(averageGlideRatio) < 0.1
      ? null
      : (glideRatioResidualStandardDeviation / Math.abs(averageGlideRatio)) *
        100;
  const meaningfulPitchReversals = countMeaningfulPitchReversals(
    samples.map((sample) => sample.diveAngleDeg),
  );
  const transitionBlockSize = Math.max(1, Math.floor(samples.length * 0.2));
  const startDiveAngleDeg = averageFiniteNumbers(
    samples
      .slice(0, transitionBlockSize)
      .map((sample) => sample.diveAngleDeg),
  );
  const endDiveAngleDeg = averageFiniteNumbers(
    samples
      .slice(-transitionBlockSize)
      .map((sample) => sample.diveAngleDeg),
  );
  const diveAngleChangeDeg =
    startDiveAngleDeg === null || endDiveAngleDeg === null
      ? null
      : endDiveAngleDeg - startDiveAngleDeg;

  if (speedVariationPercent === null || diveAngleVariationDeg === null) {
    return insufficientResult;
  }

  const glideRatioIsSmooth =
    glideRatioVariationPercent === null || glideRatioVariationPercent <= 25;
  const glideRatioIsControlled =
    glideRatioVariationPercent === null || glideRatioVariationPercent <= 38;
  const transitionIsSmooth =
    speedVariationPercent <= 6 &&
    diveAngleVariationDeg <= 4 &&
    meaningfulPitchReversals <= 2 &&
    glideRatioIsSmooth;
  const transitionIsControlled =
    speedVariationPercent <= 9 &&
    diveAngleVariationDeg <= 7 &&
    meaningfulPitchReversals <= 4 &&
    glideRatioIsControlled;

  if (transitionIsSmooth) {
    return {
      rating: "good",
      label: "Clean transition",
      summary: `From the flare apex into sustained flight, speed, pitch and GR settled progressively over ${formatNumber(durationSeconds, 1)} seconds without excessive back-and-forth correction.`,
      durationSeconds,
      speedVariationPercent,
      diveAngleVariationDeg,
      glideRatioVariationPercent,
      meaningfulPitchReversals,
      diveAngleChangeDeg,
    };
  }

  const issues: string[] = [];

  if (speedVariationPercent > 6) {
    issues.push("speed did not settle progressively");
  }

  if (diveAngleVariationDeg > 4 || meaningfulPitchReversals > 2) {
    issues.push(
      meaningfulPitchReversals > 2
        ? `${meaningfulPitchReversals} meaningful pitch reversals occurred`
        : "pitch varied around its settling trend",
    );
  }

  if (!glideRatioIsSmooth) {
    issues.push("GR overshot or changed unevenly");
  }

  return {
    rating: transitionIsControlled ? "mixed" : "poor",
    label: transitionIsControlled
      ? "Mostly controlled transition"
      : "Unsettled transition",
    summary: transitionIsControlled
      ? `The transition into sustained flight was usable, but ${issues.join("; ")}.`
      : `The transition into sustained flight needs attention: ${issues.join("; ")}.`,
    durationSeconds,
    speedVariationPercent,
    diveAngleVariationDeg,
    glideRatioVariationPercent,
    meaningfulPitchReversals,
    diveAngleChangeDeg,
  };
}

function analyzeTargetAdherence(
  task: TaskMode,
  samples: TargetAdherenceSample[],
): TargetAdherenceResult | null {
  if (samples.length < 4) {
    return null;
  }

  const isSpeedTask = task === "speed";
  const tolerance = isSpeedTask ? 0.15 : 10;
  const differences = samples.map(
    (sample) => sample.actualValue - sample.targetValue,
  );
  const averageTarget =
    samples.reduce((total, sample) => total + sample.targetValue, 0) /
    samples.length;
  const averageActual =
    samples.reduce((total, sample) => total + sample.actualValue, 0) /
    samples.length;
  const meanAbsoluteError =
    differences.reduce((total, difference) => total + Math.abs(difference), 0) /
    differences.length;
  const averageDifference =
    differences.reduce((total, difference) => total + difference, 0) /
    differences.length;
  const withinTargetPercent =
    (differences.filter((difference) => Math.abs(difference) <= tolerance)
      .length /
      differences.length) *
    100;
  const rating: EnergyManagementRating =
    withinTargetPercent >= 70 && meanAbsoluteError <= tolerance
      ? "good"
      : withinTargetPercent >= 40 && meanAbsoluteError <= tolerance * 1.6
        ? "mixed"
        : "poor";
  const targetLabel = isSpeedTask ? "GR" : "airspeed";
  const toleranceLabel = isSpeedTask ? "±0.15 GR" : "±10 km/h";
  const differenceMagnitude = Math.abs(averageDifference);
  const differenceDirection =
    differenceMagnitude <= tolerance * 0.25
      ? "centred on the target"
      : isSpeedTask
        ? averageDifference < 0
          ? "below the target, indicating a steeper-than-planned flight path"
          : "above the target, indicating a flatter-than-planned flight path"
        : averageDifference < 0
          ? "below the target speed"
          : "above the target speed";
  const label =
    rating === "good"
      ? "Target followed well"
      : rating === "mixed"
        ? "Target followed inconsistently"
        : "Target missed for much of the window";
  const formattedAverageDifference = isSpeedTask
    ? `${formatNumber(differenceMagnitude, 2)} GR`
    : `${formatNumber(differenceMagnitude, 1)} km/h`;
  const firstTargetValue = samples[0].targetValue;
  const lastTargetValue = samples[samples.length - 1].targetValue;
  const targetProfileDescription = isSpeedTask
    ? `${formatNumber(firstTargetValue, 2)}→${formatNumber(lastTargetValue, 2)} GR`
    : `${formatNumber(firstTargetValue, 0)}→${formatNumber(lastTargetValue, 0)} km/h`;

  return {
    rating,
    label,
    summary: `${formatNumber(withinTargetPercent, 0)}% of the evaluated flight was within ${toleranceLabel} of the personal zero-wind ${targetProfileDescription} profile. On average the flown trace was ${formattedAverageDifference} ${differenceDirection}.`,
    targetLabel,
    toleranceLabel,
    averageTarget,
    averageActual,
    meanAbsoluteError,
    averageDifference,
    withinTargetPercent,
  };
}

function buildTrackAssessment({
  task,
  timeSeconds,
  distanceM,
  speedKmh,
  peakDiveAngleDeg,
  peakVerticalSpeedKmh,
  peakTotalSpeedKmh,
  entryGlideRatio,
  exitGlideRatio,
  flareStartAltitudeM,
  flareAltitudeGainM,
  last800mHorizontalSpeedKmh,
  last800mGlideRatio,
  lineEfficiencyPercent,
  tailwindKts,
  usesCalculatedAirspeed,
  targetAdherence,
  flightTransition,
  energyManagement,
}: TrackAssessmentMetrics): TrackAssessment {
  const strengths: string[] = [];
  const evidence: string[] = [];
  const diveAngleOnTarget =
    peakDiveAngleDeg !== null &&
    peakDiveAngleDeg >= ASSESSOR_ZERO_WIND_TARGETS.diveAngleMinDeg &&
    peakDiveAngleDeg <= ASSESSOR_ZERO_WIND_TARGETS.diveAngleMaxDeg;
  const verticalSpeedOnTarget =
    peakVerticalSpeedKmh !== null &&
    peakVerticalSpeedKmh >= ASSESSOR_ZERO_WIND_TARGETS.verticalSpeedKmh - 5;

  evidence.push(
    usesCalculatedAirspeed
      ? "Assessment basis: calculated airspeed with the horizontal wind removed, compared with zero-wind targets."
      : "Assessment basis: ground-relative speed as a provisional fallback. Load wind data for a calculated-airspeed comparison with the zero-wind targets.",
  );

  if (targetAdherence !== null) {
    const targetUnit =
      targetAdherence.targetLabel === "GR" ? "GR" : "km/h";
    evidence.push(
      `Target adherence: ${formatNumber(targetAdherence.withinTargetPercent, 0)}% within ${targetAdherence.toleranceLabel}; average flown ${formatNumber(targetAdherence.averageActual, targetUnit === "GR" ? 2 : 1)} ${targetUnit} against average target ${formatNumber(targetAdherence.averageTarget, targetUnit === "GR" ? 2 : 1)} ${targetUnit}.`,
    );
  }

  if (diveAngleOnTarget && verticalSpeedOnTarget) {
    strengths.push(
      `The dive built the intended energy: ${formatNumber(peakDiveAngleDeg, 1)}° and ${formatNumber(peakVerticalSpeedKmh, 1)} km/h vertical.`,
    );
  } else if (peakTotalSpeedKmh !== null && peakTotalSpeedKmh >= 350) {
    strengths.push(
      `The run still produced strong total energy, peaking at ${formatNumber(peakTotalSpeedKmh, 1)} km/h.`,
    );
  }

  if (task !== "speed" && flightTransition !== null) {
    evidence.push(
      `Post-flare transition: ${formatNumber(flightTransition.durationSeconds, 1)} seconds with ${flightTransition.meaningfulPitchReversals} meaningful pitch reversals.`,
    );

    if (
      flightTransition.speedVariationPercent !== null &&
      flightTransition.diveAngleVariationDeg !== null
    ) {
      evidence.push(
        `Transition smoothness after removing the settling trend: ${formatNumber(flightTransition.speedVariationPercent, 1)}% in total speed and ${formatNumber(flightTransition.diveAngleVariationDeg, 2)}° in dive angle.`,
      );
    }
  }

  if (task !== "speed" && energyManagement !== null) {
    if (energyManagement.rating === "good") {
      strengths.push(energyManagement.summary);
    }

    if (energyManagement.speedRetentionPercent !== null) {
      evidence.push(
        `Post-flare total-speed retention: ${formatNumber(energyManagement.speedRetentionPercent, 0)}% over ${formatNumber(energyManagement.durationSeconds, 1)} seconds.`,
      );
    }

    if (
      energyManagement.speedBleedPercentPerSecond !== null &&
      energyManagement.diveAngleVariationDeg !== null
    ) {
      evidence.push(
        `Energy stability: ${formatNumber(energyManagement.speedBleedPercentPerSecond, 2)}% speed bleed per second, ${formatNumber(energyManagement.diveAngleVariationDeg, 2)}° detrended dive-angle variation and ${energyManagement.meaningfulPitchReversals} meaningful pitch reversals.`,
      );
    }

    if (
      energyManagement.speedVariationPercent !== null &&
      energyManagement.glideRatioVariationPercent !== null
    ) {
      evidence.push(
        `Up-and-down variation after removing the overall trend: ${formatNumber(energyManagement.speedVariationPercent, 1)}% in total speed and ${formatNumber(energyManagement.glideRatioVariationPercent, 1)}% in GR.`,
      );
    }
  }

  if (task === "speed") {
    const entryDifference =
      entryGlideRatio === null
        ? null
        : entryGlideRatio - ASSESSOR_ZERO_WIND_TARGETS.entryGlideRatio;
    const entryOnTarget =
      entryDifference !== null && Math.abs(entryDifference) <= 0.1;
    const headline =
      speedKmh !== null && speedKmh >= ASSESSOR_ZERO_WIND_TARGETS.speedKmh
        ? entryOnTarget
          ? "Strong Speed run"
          : "Good Speed run with entry timing to improve"
        : "Speed run review";

    if (
      entryGlideRatio !== null &&
      exitGlideRatio !== null &&
      exitGlideRatio > entryGlideRatio
    ) {
      strengths.push(
        `GR increased progressively from ${formatNumber(entryGlideRatio, 2)} at entry to ${formatNumber(exitGlideRatio, 2)} at exit.`,
      );
    }

    let improvement =
      entryGlideRatio === null
        ? "Confirm a clean window entry so the assessor can compare entry GR with the 1.0 target."
        : entryGlideRatio < 0.9
          ? `Begin the conversion earlier so GR is about 1.0 at window entry; this run entered at ${formatNumber(entryGlideRatio, 2)}.`
          : entryGlideRatio > 1.1
            ? `Avoid becoming too flat before the window; entry GR was ${formatNumber(entryGlideRatio, 2)} against the 1.0 target.`
            : "Window-entry GR was close to the 1.0 target. Focus on repeating the same timing cleanly.";

    if (targetAdherence?.rating === "poor") {
      improvement =
        targetAdherence.averageDifference < 0
          ? "After entering the window, allow GR to increase toward the target line more progressively; the flight remained steeper than planned for much of the window."
          : "Hold a slightly steeper flight path through the window; GR remained above the target line, indicating the suit became flatter than planned.";
    }

    evidence.push(
      `${usesCalculatedAirspeed ? "Calculated-air" : "Ground-relative"} Speed result: ${formatNumber(speedKmh, 1)} km/h from ${formatNumber(distanceM, 0)} m in ${formatNumber(timeSeconds, 2)} seconds; zero-wind target ${ASSESSOR_ZERO_WIND_TARGETS.speedKmh} km/h.`,
    );

    if (usesCalculatedAirspeed) {
      evidence.push(
        "The loaded wind profile has already been removed from horizontal speed and GR; no additional tailwind allowance is applied.",
      );
    } else if (tailwindKts !== null) {
      evidence.push(
        `Tailwind allowance at exit: +${formatNumber((tailwindKts / 10) * 0.1, 2)} GR for ${formatNumber(tailwindKts, 0)} kt along-track tailwind.`,
      );
    } else {
      evidence.push(
        "Exit GR remains contextual until the along-track tailwind is entered.",
      );
    }

    return {
      headline,
      summary:
        `Speed feedback compares the flown ${usesCalculatedAirspeed ? "calculated airspeed" : "provisional ground speed"} with the ${ASSESSOR_ZERO_WIND_TARGETS.speedKmh} km/h zero-wind target, then reviews entry GR and conversion timing.`,
      strengths,
      improvement,
      evidence,
      targetAdherence,
      flightTransition: null,
      energyManagement: null,
    };
  }

  if (task === "time") {
    if (flareAltitudeGainM !== null && flareAltitudeGainM >= 40) {
      strengths.push(
        `The flare converted speed into ${formatNumber(flareAltitudeGainM, 0)} m of altitude gain.`,
      );
    }

    if (last800mGlideRatio !== null) {
      strengths.push(
        `The last 800 m averaged GR ${formatNumber(last800mGlideRatio, 2)}, showing the sustained portion of the flight.`,
      );
    }

    let improvement =
      !diveAngleOnTarget || !verticalSpeedOnTarget
        ? `Build slightly more dive energy before conversion; the personal target is roughly 70–80° and 300 km/h vertical.`
        : flareStartAltitudeM !== null && flareStartAltitudeM < 2475
          ? `Start the conversion closer to the 2500 m window top; this flare was detected at ${formatNumber(flareStartAltitudeM, 0)} m.`
          : "The major phases are close to the personal Time baseline. Look for smaller gains in flare timing and sustained efficiency.";

    if (energyManagement?.rating === "poor") {
      improvement =
        "Prioritise a steadier post-flare pitch. Repeated changes in dive angle are producing up-and-down changes in speed or GR instead of a smooth energy bleed.";
    }

    evidence.push(
      `Time result: ${formatNumber(timeSeconds, 2)} seconds; zero-wind target ${ASSESSOR_ZERO_WIND_TARGETS.timeSeconds} seconds.`,
    );
    if (flareStartAltitudeM !== null) {
      evidence.push(
        `Flare detected at ${formatNumber(flareStartAltitudeM, 0)} m AGL.`,
      );
    }

    return {
      headline:
        timeSeconds >= ASSESSOR_ZERO_WIND_TARGETS.timeSeconds
          ? "Very good Time run"
          : "Time run review",
      summary:
        `Time feedback compares the ${formatNumber(timeSeconds, 2)}-second result with the ${ASSESSOR_ZERO_WIND_TARGETS.timeSeconds}-second zero-wind target, using ${usesCalculatedAirspeed ? "calculated airspeed" : "provisional ground-relative speed"} for the flight phases.`,
      strengths,
      improvement,
      evidence,
      targetAdherence,
      flightTransition,
      energyManagement,
    };
  }

  if (lineEfficiencyPercent !== null && lineEfficiencyPercent >= 99.5) {
    strengths.push(
      `The track was ${formatNumber(lineEfficiencyPercent, 2)}% line-efficient, with very little distance lost to course deviation.`,
    );
  }

  if (
    last800mHorizontalSpeedKmh !== null &&
    last800mGlideRatio !== null
  ) {
    strengths.push(
      `The last 800 m averaged ${formatNumber(last800mHorizontalSpeedKmh, 1)} km/h horizontal at GR ${formatNumber(last800mGlideRatio, 2)}.`,
    );
  }

  let improvement =
    (peakDiveAngleDeg !== null && peakDiveAngleDeg < 65) ||
    (peakVerticalSpeedKmh !== null && peakVerticalSpeedKmh < 285)
      ? "There may be a little more distance available from additional dive energy, provided the flare remains controlled."
      : flareStartAltitudeM !== null && flareStartAltitudeM < 2475
        ? `Consider shifting the conversion slightly upward; the flare was detected at ${formatNumber(flareStartAltitudeM, 0)} m AGL.`
        : "The run is close to the personal Distance baseline. Look for small gains in conversion timing and late-window speed retention.";

  if (energyManagement?.rating === "poor") {
    improvement =
      "Prioritise a steadier post-flare pitch. Repeated changes in dive angle are producing up-and-down changes in speed or GR instead of preserving forward energy.";
  }

  evidence.push(
    `${usesCalculatedAirspeed ? "Calculated-air" : "Ground-relative"} Distance result: ${formatNumber(distanceM, 0)} m; zero-wind target ${ASSESSOR_ZERO_WIND_TARGETS.distanceM} m.`,
  );
  if (flareAltitudeGainM !== null) {
    evidence.push(
      `Flare altitude gain: ${formatNumber(flareAltitudeGainM, 0)} m.`,
    );
  }

  return {
    headline:
      distanceM >= ASSESSOR_ZERO_WIND_TARGETS.distanceM &&
      lineEfficiencyPercent !== null &&
      lineEfficiencyPercent >= 99.5
        ? "Very good Distance run"
        : "Distance run review",
    summary:
      `Distance feedback compares the flown ${usesCalculatedAirspeed ? "air-relative distance" : "provisional ground distance"} with the ${ASSESSOR_ZERO_WIND_TARGETS.distanceM} m zero-wind target, then reviews conversion, line efficiency and late-window energy.`,
    strengths,
    improvement,
    evidence,
    targetAdherence,
    flightTransition,
    energyManagement,
  };
}

type WindSource =
  | "manual"
  | "mark-schulze"
  | "open-meteo"
  | "meteomatics"
  | "windy";
type SuitSetup =
  | ""
  | "crplus-no-wingtips"
  | "crplus-wingtips"
  | "freak-atc"
  | "swift";
type UnitSystem = "metric" | "imperial";
type SavedFindNumbers = {
  distanceSpeedKph: string;
  timeSpeedKph: string;
  speedStartGR: string;
  speedEndGR: string;
};

function areFindNumbersValid(numbers: SavedFindNumbers): boolean {
  const distanceSpeedKph = Number(numbers.distanceSpeedKph);
  const timeSpeedKph = Number(numbers.timeSpeedKph);
  const speedStartGR = Number(numbers.speedStartGR);
  const speedEndGR = Number(numbers.speedEndGR);

  return (
    Number.isFinite(distanceSpeedKph) &&
    distanceSpeedKph > 0 &&
    Number.isFinite(timeSpeedKph) &&
    timeSpeedKph > 0 &&
    Number.isFinite(speedStartGR) &&
    speedStartGR > 0 &&
    Number.isFinite(speedEndGR) &&
    speedEndGR > speedStartGR
  );
}

type SavedFindDetails = {
  version: 1;
  unitSystem: UnitSystem;
  weight: string;
  heightCm: string;
  heightFeet: string;
  heightInches: string;
  suitSetup: Exclude<SuitSetup, "">;
  numbers?: SavedFindNumbers;
};

const FIND_DETAILS_METADATA_KEY = "numbers_to_fly_details";
const SAVABLE_SUIT_SETUPS: readonly Exclude<SuitSetup, "">[] = [
  "crplus-no-wingtips",
  "crplus-wingtips",
  "freak-atc",
  "swift",
];

function getSavedFindNumbers(value: unknown): SavedFindNumbers | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const numbers = value as Record<string, unknown>;

  if (
    typeof numbers.distanceSpeedKph !== "string" ||
    typeof numbers.timeSpeedKph !== "string" ||
    typeof numbers.speedStartGR !== "string" ||
    typeof numbers.speedEndGR !== "string"
  ) {
    return null;
  }

  const savedNumbers = {
    distanceSpeedKph: numbers.distanceSpeedKph,
    timeSpeedKph: numbers.timeSpeedKph,
    speedStartGR: numbers.speedStartGR,
    speedEndGR: numbers.speedEndGR,
  };

  return areFindNumbersValid(savedNumbers) ? savedNumbers : null;
}

function getSavedFindDetails(session: Session | null): SavedFindDetails | null {
  const value = session?.user.user_metadata?.[FIND_DETAILS_METADATA_KEY];

  if (!value || typeof value !== "object") {
    return null;
  }

  const details = value as Record<string, unknown>;
  const unitSystem = details.unitSystem;
  const suitSetup = details.suitSetup;
  const numbers = getSavedFindNumbers(details.numbers);

  if (
    details.version !== 1 ||
    (unitSystem !== "metric" && unitSystem !== "imperial") ||
    typeof details.weight !== "string" ||
    typeof details.heightCm !== "string" ||
    typeof details.heightFeet !== "string" ||
    typeof details.heightInches !== "string" ||
    !SAVABLE_SUIT_SETUPS.includes(
      suitSetup as Exclude<SuitSetup, "">,
    )
  ) {
    return null;
  }

  return {
    version: 1,
    unitSystem,
    weight: details.weight,
    heightCm: details.heightCm,
    heightFeet: details.heightFeet,
    heightInches: details.heightInches,
    suitSetup: suitSetup as Exclude<SuitSetup, "">,
    ...(numbers ? { numbers } : {}),
  };
}

type ConfigTask = "distance" | "speed" | "time";

type StoredConfigTonePresets = Partial<
  Record<
    ConfigTask,
    {
      toneMin: string;
      toneMax: string;
    }
  >
>;

type ConfigSuit =
  | "crplus-wingtips"
  | "crplus-no-wingtips"
  | "freak"
  | "atc"
  | "swift";

type WindLayer = {
  altitudeM: number;
  directionFromDeg: string;
  speedKt: string;
};

type WindComponents = {
  tailwindKt: number;
  crosswindKt: number;
};

type ResultRow = {
  altitudeM: number;
  tailwindKt: number;
  crosswindKt: number;
  effectiveWindAheadKt?: number;
  targetSpeedKph?: number;
  targetGR?: number;
};

type MarkSchulzeResponse = {
  altSI?: number[];
  directionSI?: Record<string, number>;
  speedSI?: Record<string, number>;
  model?: string;
};

type MeteomaticsProxyResponse = MarkSchulzeResponse & {
  winds?: WindLayer[];
};

type OpenMeteoResponse = {
  hourly?: {
    time?: string[];
    wind_speed_1000hPa?: number[];
    wind_direction_1000hPa?: number[];
    wind_speed_925hPa?: number[];
    wind_direction_925hPa?: number[];
    wind_speed_850hPa?: number[];
    wind_direction_850hPa?: number[];
    wind_speed_700hPa?: number[];
    wind_direction_700hPa?: number[];
    };
};

  type HistoricalForecastResponse = {
    hourly?: {
      time?: string[];

      wind_speed_925hPa?: number[];
      wind_direction_925hPa?: number[];
      geopotential_height_925hPa?: number[];

      wind_speed_900hPa?: number[];
      wind_direction_900hPa?: number[];
      geopotential_height_900hPa?: number[];

      wind_speed_850hPa?: number[];
      wind_direction_850hPa?: number[];
      geopotential_height_850hPa?: number[];

      wind_speed_800hPa?: number[];
      wind_direction_800hPa?: number[];
      geopotential_height_800hPa?: number[];

      wind_speed_700hPa?: number[];
      wind_direction_700hPa?: number[];
      geopotential_height_700hPa?: number[];

      wind_speed_600hPa?: number[];
      wind_direction_600hPa?: number[];
      geopotential_height_600hPa?: number[];
    };

    hourly_units?: Record<string, string>;
  };

  async function fetchHistoricalWindProfile({
  latitude,
  longitude,
  timestampMs,
  dzElevationM,
}: {
  latitude: number;
  longitude: number;
  timestampMs: number;
  dzElevationM: number;
}): Promise<WindLayer[]> {
  const jumpDate = new Date(timestampMs).toISOString().slice(0, 10);

  const hourlyVariables = [
    "wind_speed_925hPa",
    "wind_direction_925hPa",
    "geopotential_height_925hPa",
    "wind_speed_900hPa",
    "wind_direction_900hPa",
    "geopotential_height_900hPa",
    "wind_speed_850hPa",
    "wind_direction_850hPa",
    "geopotential_height_850hPa",
    "wind_speed_800hPa",
    "wind_direction_800hPa",
    "geopotential_height_800hPa",
    "wind_speed_700hPa",
    "wind_direction_700hPa",
    "geopotential_height_700hPa",
    "wind_speed_600hPa",
    "wind_direction_600hPa",
    "geopotential_height_600hPa",
  ];

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: jumpDate,
    end_date: jumpDate,
    hourly: hourlyVariables.join(","),
    timezone: "UTC",
    wind_speed_unit: "kmh",
  });

  const response = await fetch(
    `https://historical-forecast-api.open-meteo.com/v1/forecast?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `Historical wind request failed with status ${response.status}.`
    );
  }

  const data = (await response.json()) as HistoricalForecastResponse;
  const hourly = data.hourly;

  if (!hourly?.time || hourly.time.length === 0) {
    throw new Error("Historical forecast did not contain hourly wind data.");
  }

  let nearestHourIndex = 0;
  let nearestTimeDifferenceMs = Infinity;

  hourly.time.forEach((time, index) => {
    const hourlyTimestampMs = Date.parse(
      time.endsWith("Z") ? time : `${time}Z`
    );

    const differenceMs = Math.abs(hourlyTimestampMs - timestampMs);

    if (differenceMs < nearestTimeDifferenceMs) {
      nearestTimeDifferenceMs = differenceMs;
      nearestHourIndex = index;
    }
  });

  const pressureLevels = [925, 900, 850, 800, 700, 600] as const;

  const windLayers = pressureLevels.flatMap((pressureLevel) => {
    const speedKey =
      `wind_speed_${pressureLevel}hPa` as keyof NonNullable<
        HistoricalForecastResponse["hourly"]
      >;

    const directionKey =
      `wind_direction_${pressureLevel}hPa` as keyof NonNullable<
        HistoricalForecastResponse["hourly"]
      >;

    const heightKey =
      `geopotential_height_${pressureLevel}hPa` as keyof NonNullable<
        HistoricalForecastResponse["hourly"]
      >;

    const speedValues = hourly[speedKey] as number[] | undefined;
    const directionValues = hourly[directionKey] as number[] | undefined;
    const heightValues = hourly[heightKey] as number[] | undefined;

    const speedKmh = speedValues?.[nearestHourIndex];
    const directionFromDeg = directionValues?.[nearestHourIndex];
    const geopotentialHeightMslM = heightValues?.[nearestHourIndex];

    if (
      !Number.isFinite(speedKmh) ||
      !Number.isFinite(directionFromDeg) ||
      !Number.isFinite(geopotentialHeightMslM)
    ) {
      return [];
    }

    return [
      {
        altitudeM: Math.round(
          Number(geopotentialHeightMslM) - dzElevationM
        ),
        directionFromDeg: String(Number(directionFromDeg)),
        speedKt: String(kmhToKt(Number(speedKmh))),
      },
    ];
  });

  if (windLayers.length < 2) {
    throw new Error(
      "Not enough historical pressure-level winds were returned."
    );
  }

  return windLayers.sort((a, b) => a.altitudeM - b.altitudeM);
}

type WindAdvantageSummary = {
  averageTailwindKt: number;
  bestAverageTailwindKt: number;
  worstAverageTailwindKt: number;
  bestHeadingDeg: number;
  score: number;
  color: string;
};

const altitudes = [
  2500, 2400, 2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500,
];

const compareTrackColors = [
  "#ef4444",
  "#2563eb",
  "#39ff14",
  "#ff00ff",
  "#ffffff",
  "#f97316",
];
const comparePreWindowSeconds = 25;
const comparePostWindowSeconds = 35;

type CompareTrackOption = {
  id: string;
  label: string;
  rawCsv: string;
  dzElevationM: number;
  taskType: LogbookTrackType | null;
};

function formatLogbookTrackType(taskType: LogbookTrackType | null): string {
  if (taskType === "non-comp") return "Non-comp";
  if (taskType === null) return "Not set";
  return taskType[0].toUpperCase() + taskType.slice(1);
}

function formatLogbookDateTime(value: string | null): string {
  if (!value) return "Not available";

  return new Date(value).toLocaleString([], {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const defaultWinds: WindLayer[] = altitudes.map((altitudeM) => ({
  altitudeM,
  directionFromDeg: "",
  speedKt: "",
}));

const tailHeadDeadbandKt = 2;
const windProxyUrl =
  "https://numbers-to-fly-winds.flywithcruza.workers.dev";

const referencePointIcon = L.divIcon({
  className: "reference-point-marker",
  html: "<div></div>",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

function savedReferencePointMapIcon(index: number, selected: boolean) {
  return L.divIcon({
    className: `saved-reference-map-marker${selected ? " is-selected" : ""}`,
    html: `<div>${index + 1}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

const dropPointIcon = L.divIcon({
  className: "drop-point-marker",
  html: "<div></div>",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const userLocationIcon = L.divIcon({
  className: "user-location-marker",
  html: "<div></div>",
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function numberFromInput(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberFromInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lbToKg(weightLb: number): number {
  return weightLb / 2.20462;
}

function kgToLb(weightKg: number): number {
  return weightKg * 2.20462;
}

function cmToInches(heightCm: number): number {
  return heightCm / 2.54;
}

function inchesToCm(heightInches: number): number {
  return heightInches * 2.54;
}

function feetAndInchesToTotalInches(feet: string, inches: string): number {
  return numberFromInput(feet, 0) * 12 + numberFromInput(inches, 0);
}

function splitInchesToFeetAndInches(totalInches: number): {
  feet: number;
  inches: number;
} {
  const rounded = Math.round(totalInches);

  return {
    feet: Math.floor(rounded / 12),
    inches: rounded % 12,
  };
}

function kmhToCms(speedKph: number): number {
  return Math.round((speedKph / 3.6) * 100);
}

function grToFlySightValue(gr: number): number {
  return Math.round(gr * 100);
}

function timezoneHoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

function getDeviceTimezoneOffsetSeconds(): number {
  return -new Date().getTimezoneOffset() * 60;
}

function getSuitDistanceGR(configSuit: ConfigSuit): {
  minGR: number;
  maxGR: number;
} {
  const maxGRBySuit: Record<ConfigSuit, number> = {
    "crplus-wingtips": 3.7,
    "crplus-no-wingtips": 3.4,
    freak: 2.8,
    atc: 2.5,
    swift: 2.2,
  };

  const maxGR = maxGRBySuit[configSuit];

  return {
    maxGR,
    minGR: Number((maxGR - 0.4).toFixed(1)),
  };
}

function getPilotBodyAdjustmentKph({
  weight,
  unitSystem,
  heightCm,
  heightFeet,
  heightInches,
}: {
  weight: string;
  unitSystem: UnitSystem;
  heightCm: string;
  heightFeet: string;
  heightInches: string;
}): number {
  const referenceWeightLb = 175;
  const referenceHeightIn = 71;

  const weightNumber = optionalNumberFromInput(weight);

  const weightLb =
    weightNumber === null
      ? referenceWeightLb
      : unitSystem === "metric"
        ? kgToLb(weightNumber)
        : weightNumber;

  const hasMetricHeight = heightCm.trim() !== "";
  const hasImperialHeight =
    heightFeet.trim() !== "" || heightInches.trim() !== "";

  const pilotHeightIn =
    unitSystem === "metric"
      ? hasMetricHeight
        ? cmToInches(numberFromInput(heightCm, 0))
        : referenceHeightIn
      : hasImperialHeight
        ? feetAndInchesToTotalInches(heightFeet, heightInches)
        : referenceHeightIn;

  const weightDeltaLb = weightLb - referenceWeightLb;
  const heightDeltaIn = pilotHeightIn - referenceHeightIn;

  return weightDeltaLb * 0.55 - heightDeltaIn * 1.5;
}

function mapSuitSetupToConfigSuit(suitSetup: SuitSetup): ConfigSuit {
  if (suitSetup === "crplus-wingtips") return "crplus-wingtips";
  if (suitSetup === "crplus-no-wingtips") return "crplus-no-wingtips";
  if (suitSetup === "swift") return "swift";
  if (suitSetup === "freak-atc") return "freak";

  return "crplus-no-wingtips";
}

function getConfigTonePreset({
  task,
  configSuit,
  bodyAdjustmentKph,
}: {
  task: ConfigTask;
  configSuit: ConfigSuit;
  bodyAdjustmentKph: number;
}): {
  toneMin: number;
  toneMax: number;
} {
  if (task === "distance") {
    const suitGR = getSuitDistanceGR(configSuit);

    return {
      toneMin: suitGR.minGR,
      toneMax: suitGR.maxGR,
    };
  }

  const speedToneBySuit: Record<
    ConfigSuit,
    { lowKph: number; highKph: number }
  > = {
    swift: { lowKph: 170, highKph: 200 },
    atc: { lowKph: 190, highKph: 220 },
    freak: { lowKph: 210, highKph: 240 },
    "crplus-no-wingtips": { lowKph: 230, highKph: 260 },
    "crplus-wingtips": { lowKph: 220, highKph: 250 },
  };

  const timeToneBySuit: Record<
    ConfigSuit,
    { lowKph: number; highKph: number }
  > = {
    swift: { lowKph: 70, highKph: 76 },
    atc: { lowKph: 60, highKph: 66 },
    freak: { lowKph: 54, highKph: 60 },
    "crplus-no-wingtips": { lowKph: 45, highKph: 51 },
    "crplus-wingtips": { lowKph: 40, highKph: 46 },
  };

  if (task === "speed") {
    const base = speedToneBySuit[configSuit];

    return {
      toneMin: Math.round(base.lowKph + bodyAdjustmentKph),
      toneMax: Math.round(base.highKph + bodyAdjustmentKph),
    };
  }

  const base = timeToneBySuit[configSuit];

  const verticalAdjustmentKph = Math.min(
    Math.max(bodyAdjustmentKph * 0.25, -5),
    5
  );

  return {
    toneMin: Math.round(base.lowKph + verticalAdjustmentKph),
    toneMax: Math.round(base.highKph + verticalAdjustmentKph),
  };
}

function windAdjustedSpeedToneKph(
  baseKph: number,
  averageTailwindKt: number
): number {
  if (averageTailwindKt >= 0) {
    return Math.round(baseKph + averageTailwindKt);
  }

  return Math.round(baseKph + averageTailwindKt * 0.5);
}

function windAdjustedDistanceGR(
  baseGR: number,
  averageTailwindKt: number
): number {
  const windAdjustmentGR =
    averageTailwindKt >= 0
      ? Math.round(averageTailwindKt / 10) * 0.1
      : -Math.round(Math.abs(averageTailwindKt) / 10) * 0.2;

  return Number((baseGR + windAdjustmentGR).toFixed(1));
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

function interpolateGRByWeight(weightKg: number): {
  speedStartGR: number;
  speedEndGR: number;
} {
  const points = [
    { weightKg: 63, startGR: 0.7, endGR: 1.4 },
    { weightKg: 68, startGR: 0.8, endGR: 1.5 },
    { weightKg: 74, startGR: 0.9, endGR: 1.6 },
    { weightKg: 81, startGR: 1.0, endGR: 1.7 },
    { weightKg: 90, startGR: 1.1, endGR: 1.8 },
    { weightKg: 100, startGR: 1.2, endGR: 1.9 },
  ];

  if (weightKg <= 63) {
    return {
      speedStartGR: 0.7,
      speedEndGR: 1.4,
    };
  }

  if (weightKg >= 100) {
    return {
      speedStartGR: 1.2,
      speedEndGR: 1.9,
    };
  }

  for (let index = 0; index < points.length - 1; index++) {
    const lower = points[index];
    const upper = points[index + 1];

    if (weightKg >= lower.weightKg && weightKg <= upper.weightKg) {
      const progress =
        (weightKg - lower.weightKg) / (upper.weightKg - lower.weightKg);

      const speedStartGR =
        lower.startGR + (upper.startGR - lower.startGR) * progress;

      const speedEndGR =
        lower.endGR + (upper.endGR - lower.endGR) * progress;

      return {
        speedStartGR: Number(speedStartGR.toFixed(2)),
        speedEndGR: Number(speedEndGR.toFixed(2)),
      };
    }
  }

  return {
    speedStartGR: 1.0,
    speedEndGR: 1.7,
  };
}

function calculateFindYourNumbers({
  weight,
  unitSystem,
  heightCm,
  heightFeet,
  heightInches,
  suitSetup,
}: {
  weight: string;
  unitSystem: UnitSystem;
  heightCm: string;
  heightFeet: string;
  heightInches: string;
  suitSetup: SuitSetup;
}) {
  const referenceWeightLb = 175;
  const referenceHeightIn = 71;

  const weightNumber = optionalNumberFromInput(weight);

  const weightLb =
    weightNumber === null
      ? referenceWeightLb
      : unitSystem === "metric"
        ? kgToLb(weightNumber)
        : weightNumber;

  const hasMetricHeight = heightCm.trim() !== "";
  const hasImperialHeight =
    heightFeet.trim() !== "" || heightInches.trim() !== "";

  const pilotHeightIn =
    unitSystem === "metric"
      ? hasMetricHeight
        ? cmToInches(numberFromInput(heightCm, 0))
        : referenceHeightIn
      : hasImperialHeight
        ? feetAndInchesToTotalInches(heightFeet, heightInches)
        : referenceHeightIn;

  const weightDeltaLb = weightLb - referenceWeightLb;
  const heightDeltaIn = pilotHeightIn - referenceHeightIn;

  const bodyAdjustmentKph = weightDeltaLb * 0.55 - heightDeltaIn * 1.5;

  const suitSpeedAdjustmentKph =
    suitSetup === "crplus-wingtips"
      ? -10
      : suitSetup === "freak-atc"
        ? 5
        : suitSetup === "swift"
          ? 10
          : 0;

  const distanceSpeedKph = Math.round(
    185 + bodyAdjustmentKph + suitSpeedAdjustmentKph
  );

  const timeSpeedKph = Math.round(
    150 + bodyAdjustmentKph + suitSpeedAdjustmentKph
  );

  const interpolatedGR = interpolateGRByWeight(lbToKg(weightLb));

  const heightExpectedForWeightIn =
    referenceHeightIn + (weightLb - referenceWeightLb) / 10;

  const heightForWeightDeltaIn = pilotHeightIn - heightExpectedForWeightIn;

  // Positive heightForWeightDeltaIn means tall/light for their weight.
  // Negative heightForWeightDeltaIn means short/heavy for their weight.
  const wingLoadingGRCorrection = Math.min(
    Math.max(-heightForWeightDeltaIn * 0.03, -0.1),
    0.1
  );

  const speedStartGR = Number(
    Math.max(
      0.6,
      interpolatedGR.speedStartGR + wingLoadingGRCorrection
    ).toFixed(2)
  );

  const speedEndGR = Number(
    Math.max(
      speedStartGR + 0.6,
      interpolatedGR.speedEndGR + wingLoadingGRCorrection
    ).toFixed(2)
  );

  return {
    weightLb,
    weightKg: lbToKg(weightLb),
    distanceSpeedKph,
    timeSpeedKph,
    speedStartGR,
    speedEndGR,
  };
}

function generateFlySightConfig({
  task,
  dzElevM,
  timezoneOffsetHours,
  toneMin,
  toneMax,
  alarm9,
  alarm5,
  alarm4,
  alarm3,
  alarm2,
  alarm1,
  alarmBeep,
  alarmFlare,
  alarmTask,
}: {
  task: ConfigTask;
  dzElevM: string;
  timezoneOffsetHours: string;
  toneMin: string;
  toneMax: string;
  alarm9: string;
  alarm5: string;
  alarm4: string;
  alarm3: string;
  alarm2: string;
  alarm1: string;
  alarmBeep: string;
  alarmFlare: string;
  alarmTask: string;
}) {
  const taskLabel =
    task === "distance" ? "distance" : task === "speed" ? "speed" : "time";

  const toneMode = task === "distance" ? 2 : task === "speed" ? 0 : 1;

  const speechRate = task === "speed" ? 2 : 3;
  const speechMode = task === "speed" ? 2 : 0;
  const speechDecimal = task === "speed" ? 1 : 0;

  const verticalThreshold = task === "speed" ? 1000 : 0;
  const altitudeUnits = task === "time" ? 1 : 0;

  const dzElev = Math.round(numberFromInput(dzElevM, 0));

  const tzSeconds = timezoneHoursToSeconds(
    numberFromInput(timezoneOffsetHours, 0)
  );

  const minValue =
    task === "distance"
      ? grToFlySightValue(numberFromInput(toneMin, 0))
      : kmhToCms(numberFromInput(toneMin, 0));

  const maxValue =
    task === "distance"
      ? grToFlySightValue(numberFromInput(toneMax, 0))
      : kmhToCms(numberFromInput(toneMax, 0));

  const finalAlarmType = task === "time" ? 1 : 4;
  const flareAlarmType = task === "speed" ? 1 : 4;
  const toneMinQuickReference =
    task === "speed"
      ? " (6666=240kph, 6944=250kph, 7222=260kph, 7500=270kph)"
      : task === "time"
        ? " (1055=38, 1250=45kph)"
      : "";
  const toneMaxQuickReference =
    task === "speed"
      ? " (7777=280kph, 8055=290kph, 8333=300kph, 8888=320kph, 9027=325kph)"
      : task === "time"
        ? " (1194=43, 1528=55kph)"
      : "";
  
return `; GPS settings
Model:     7     ; Dynamic model
                 ;   0 = Portable
                 ;   2 = Stationary
                 ;   3 = Pedestrian
                 ;   4 = Automotive
                 ;   5 = Sea
                 ;   6 = Airborne with < 1 G acceleration
                 ;   7 = Airborne with < 2 G acceleration
                 ;   8 = Airborne with < 4 G acceleration
Rate:      200   ; Measurement rate (ms)

; Tone settings

Mode:      ${toneMode}     ; Measurement mode
                 ;   0 = Horizontal speed
                 ;   1 = Vertical speed
                 ;   2 = Glide ratio
                 ;   3 = Inverse glide ratio
                 ;   4 = Total speed
                 ;   11 = Dive angle
Min:       ${minValue}     ; Lowest pitch value${toneMinQuickReference}
                 ;   cm/s        in Mode 0, 1, or 4
                 ;   ratio * 100 in Mode 2 or 3
                 ;   degrees     in Mode 11
Max:       ${maxValue}     ; Highest pitch value${toneMaxQuickReference}
                 ;   cm/s        in Mode 0, 1, or 4
                 ;   ratio * 100 in Mode 2 or 3
                 ;   degrees     in Mode 11
Limits:    1     ; Behaviour when outside bounds
                 ;   0 = No tone
                 ;   1 = Min/max tone
                 ;   2 = Chirp up/down
                 ;   3 = Chirp down/up
Volume:    8     ; 0 (min) to 8 (max)

; Rate settings

Mode_2:    9     ; Determines tone rate
                 ;   0 = Horizontal speed
                 ;   1 = Vertical speed
                 ;   2 = Glide ratio
                 ;   3 = Inverse glide ratio
                 ;   4 = Total speed
                 ;   8 = Magnitude of Value 1
                 ;   9 = Change in Value 1
                 ;   11 = Dive angle
Min_Val_2: 300   ; Lowest rate value
                 ;   cm/s          when Mode 2 = 0, 1, or 4
                 ;   ratio * 100   when Mode 2 = 2 or 3
                 ;   percent * 100 when Mode 2 = 9
                 ;   degrees       when Mode 2 = 11
Max_Val_2: 1500  ; Highest rate value
                 ;   cm/s          when Mode 2 = 0, 1, or 4
                 ;   ratio * 100   when Mode 2 = 2 or 3
                 ;   percent * 100 when Mode 2 = 9
                 ;   degrees       when Mode 2 = 11
Min_Rate:  100   ; Minimum rate (Hz * 100)
Max_Rate:  500   ; Maximum rate (Hz * 100)
Flatline:  0     ; Flatline at minimum rate
                 ;   0 = No
                 ;   1 = Yes

; Speech settings

Sp_Rate:   ${speechRate}     ; Speech rate (s)
                 ;   0 = No speech
Sp_Volume: 8     ; 0 (min) to 8 (max)

Sp_Mode:   ${speechMode}     ; Speech mode
                 ;   0 = Horizontal speed
                 ;   1 = Vertical speed
                 ;   2 = Glide ratio
                 ;   3 = Inverse glide ratio
                 ;   4 = Total speed
                 ;   11 = Dive angle
                 ;   12 = Altitude above DZ_Elev
Sp_Units:  0     ; Speech units
                 ;   0 = km/h or m
                 ;   1 = mph or feet
Sp_Dec:    ${speechDecimal}     ; Speech precision
                 ;   Altitude step in Mode 5
                 ;   Decimal places in all other Modes

; Thresholds

V_Thresh:  ${verticalThreshold}  ; Minimum vertical speed for tone (cm/s)
H_Thresh:  0     ; Minimum horizontal speed for tone (cm/s)

; Miscellaneous

Use_SAS:   0     ; Use skydiver's airspeed
                 ;   0 = No

                 ;   1 = Yes
TZ_Offset: ${tzSeconds}     ; Timezone offset of output files in seconds
                 ;   -14400 = UTC-4
                 ;   -18000 = UTC-5
                 ;   -21600 = UTC-6
                 ;   -25200 = UTC-7
                 ;   -28800 = UTC-8
                 ;    36000 = UTC+10
                 ;    39600 = UTC+11

; Initialization

Init_Mode: 2     ; When the FlySight is powered on
                 ;   0 = Do nothing
                 ;   1 = Test speech mode
                 ;   2 = Play file
Init_File: ${taskLabel}     ; File to be played

; Alarm settings

; WARNING: GPS measurements depend on very weak signals
;          received from orbiting satellites. As such, they
;          are prone to interference, and should NEVER be
;          relied upon for life saving purposes.

;          UNDER NO CIRCUMSTANCES SHOULD THESE ALARMS BE
;          USED TO INDICATE DEPLOYMENT OR BREAKOFF ALTITUDE.

; NOTE:    Alarm elevations are given in meters above ground
;          elevation, which is specified in DZ_Elev.

Win_Above:     50 ; Window above each alarm (m)
Win_Below:     0 ; Window below each alarm (m)
DZ_Elev:       ${dzElev} ; Ground elevation (m above sea level)

Alarm_Elev:    ${Math.round(numberFromInput(alarm9, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
                 ;   0 = No alarm
                 ;   1 = Beep
                 ;   2 = Chirp up
                 ;   3 = Chirp down
                 ;   4 = Play file
Alarm_File:    9 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarm5, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
Alarm_File:    5 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarm4, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
Alarm_File:    4 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarm3, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
Alarm_File:    3 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarm2, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
Alarm_File:    2 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarm1, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
Alarm_File:    1 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarmBeep, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    1 ; Alarm type
Alarm_File:    0 ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarmFlare, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    ${flareAlarmType} ; Alarm type
Alarm_File:    ${flareAlarmType === 4 ? "flare" : "0"} ; File to be played

Alarm_Elev:    ${Math.round(numberFromInput(alarmTask, 0))} ; Alarm elevation (m above ground level)
Alarm_Type:    ${finalAlarmType} ; Alarm type
Alarm_File:    ${finalAlarmType === 4 ? taskLabel : "0"} ; File to be played

Alarm_Elev:    1220 ; Alarm elevation (m above ground level)
Alarm_Type:    4 ; Alarm type
                 ;   0 = No alarm
                 ;   1 = Beep
                 ;   2 = Chirp up
                 ;   3 = Chirp down
                 ;   4 = Play file
Alarm_File:    4 ; File to be played

; Altitude mode settings

; WARNING: GPS measurements depend on very weak signals
;          received from orbiting satellites. As such, they
;          are prone to interference, and should NEVER be
;          relied upon for life saving purposes.

;          UNDER NO CIRCUMSTANCES SHOULD ALTITUDE MODE BE
;          USED TO INDICATE DEPLOYMENT OR BREAKOFF ALTITUDE.

; NOTE:    Altitude is given relative to ground elevation,
;          which is specified in DZ_Elev. Altitude mode will
;          not function below 1500 m above ground.

Alt_Units:     ${altitudeUnits} ; Altitude units
                 ;   0 = m
                 ;   1 = ft
Alt_Step:      0 ; Altitude between announcements
                 ;   0 = No altitude

; Silence windows

; NOTE:    Silence windows are given in meters above ground
;          elevation, which is specified in DZ_Elev. Tones
;          will be silenced during these windows and only
;          alarms will be audible.

Win_Top:       4300 ; Silence window top (m)
Win_Bottom:    ${Math.round(numberFromInput(alarmBeep, 2500))} ; Silence window bottom (m)
`;
}

function kmhToKt(speedKmh: number): number {
  return speedKmh / 1.852;
}

function applyTailHeadDeadband(tailwindKt: number): number {
  if (Math.abs(tailwindKt) <= tailHeadDeadbandKt) return 0;
  return tailwindKt;
}

function windComponents(
  runHeadingDeg: number,
  windFromDeg: number,
  windSpeedKt: number
): WindComponents {
  const windTowardDeg = normalizeDeg(windFromDeg + 180);
  const angle = signedAngleDeg(runHeadingDeg, windTowardDeg);

  const rawTailwindKt = windSpeedKt * Math.cos(degToRad(angle));
  const crosswindKt = windSpeedKt * Math.sin(degToRad(angle));

  return {
    tailwindKt: applyTailHeadDeadband(rawTailwindKt),
    crosswindKt,
  };
}

function averageTailwindForHeading(
  headingDeg: number,
  winds: WindLayer[]
): number {
  if (winds.length === 0) return 0;

  const tailwinds = winds.map((wind) => {
    const components = windComponents(
      headingDeg,
      numberFromInput(wind.directionFromDeg, 0),
      numberFromInput(wind.speedKt, 0)
    );

    return components.tailwindKt;
  });

  return (
    tailwinds.reduce((total, tailwindKt) => total + tailwindKt, 0) /
    tailwinds.length
  );
}

function flightLineColourFromHeadingDifference(
  selectedHeadingDeg: number,
  bestHeadingDeg: number
): string {
  const difference = Math.abs(
    signedAngleDeg(selectedHeadingDeg, bestHeadingDeg)
  );

  if (difference <= 7.5) return "#00ff5a";
  if (difference <= 15) return "#f97316";
  return "#ef4444";
}

function calculateWindAdvantageSummary(
  headingDeg: number,
  winds: WindLayer[]
): WindAdvantageSummary {
  const selectedHeadingDeg = normalizeDeg(headingDeg);
  const currentAverageTailwindKt = averageTailwindForHeading(
    selectedHeadingDeg,
    winds
  );

  let bestHeadingDeg = 0;
  let bestAverageTailwindKt = -Infinity;
  let worstAverageTailwindKt = Infinity;

  for (let testHeading = 0; testHeading < 360; testHeading += 1) {
    const testAverageTailwindKt = averageTailwindForHeading(testHeading, winds);

    if (testAverageTailwindKt > bestAverageTailwindKt) {
      bestAverageTailwindKt = testAverageTailwindKt;
      bestHeadingDeg = testHeading;
    }

    if (testAverageTailwindKt < worstAverageTailwindKt) {
      worstAverageTailwindKt = testAverageTailwindKt;
    }
  }

  const range = bestAverageTailwindKt - worstAverageTailwindKt;

  const rawScore =
    range <= 0.1
      ? 0.5
      : (currentAverageTailwindKt - worstAverageTailwindKt) / range;

  const score = Math.min(Math.max(rawScore, 0), 1);

  return {
    averageTailwindKt: currentAverageTailwindKt,
    bestAverageTailwindKt,
    worstAverageTailwindKt,
    bestHeadingDeg,
    score,
    color: flightLineColourFromHeadingDifference(
      selectedHeadingDeg,
      bestHeadingDeg
    ),
  };
}

function delayedPerformanceDropKph(altitudeM: number): number {
  if (altitudeM >= 2200) return 0;

  const drop = ((2200 - altitudeM) / 700) * 30;
  return Math.min(Math.max(drop, 0), 30);
}

function baseGRAtAltitude(
  altitudeM: number,
  startGR: number,
  endGR: number
): number {
  const progress = (2500 - altitudeM) / 1000;
  return startGR + (endGR - startGR) * progress;
}

function leastFavorableWindAhead(index: number, tailwindsKt: number[]): number {
  return Math.min(...tailwindsKt.slice(index));
}

function grWindCorrection(effectiveWindAheadKt: number): number {
  return effectiveWindAheadKt / 100;
}

function blendedTimeWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;
  return tailwindKt + Math.max(0, crosswindCorrectionKph - Math.abs(tailwindKt));
}

function distanceWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const tailwindCorrectionKph = Math.max(tailwindKt, 0);
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;

  return Math.max(tailwindCorrectionKph, crosswindCorrectionKph);
}

function getWindCorrectedHorizontalSpeedMps(
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

function getWindCorrectedWindowDistanceM(
  points: GpsTrackPoint[],
  winds: WindLayer[]
) {
  if (points.length < 2) {
    return 0;
  }

  return points.slice(1).reduce((total, point, index) => {
    const previousPoint = points[index];

    const previousSpeedMps = getWindCorrectedHorizontalSpeedMps(
      previousPoint,
      winds
    );
    const currentSpeedMps = getWindCorrectedHorizontalSpeedMps(point, winds);

    const averageSpeedMps = (previousSpeedMps + currentSpeedMps) / 2;

    const previousTimestamp = previousPoint.timestampMs;
    const currentTimestamp = point.timestampMs;

    const elapsedSeconds =
      previousTimestamp !== null && currentTimestamp !== null
        ? Math.max((currentTimestamp - previousTimestamp) / 1000, 0)
        : GPS_SAMPLE_PERIOD_SECONDS;

    return total + averageSpeedMps * elapsedSeconds;
  }, 0);
}

function getDisplayHorizontalSpeedMps(
  point: GpsTrackPoint,
  winds: WindLayer[],
  useCorrected: boolean
) {
  return useCorrected
    ? getWindCorrectedHorizontalSpeedMps(point, winds)
    : point.horizontalSpeedMps;
}

function getDisplayGlideRatio(
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

function getDisplayTotalSpeedMps(
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

function interpolateNumber(
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

function interpolateDirection(
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

const openMeteoPressureAltitudeM: Record<string, number> = {
  "1000": 110,
  "925": 760,
  "850": 1450,
  "700": 3000,
};

function getOpenMeteoHourlyIndex(
  data: OpenMeteoResponse,
  forecastHourOffset: number
): number {
  const times = data.hourly?.time;

  if (!times || times.length === 0) {
    return 0;
  }

  const targetTimeMs =
    Date.now() + forecastHourOffset * 60 * 60 * 1000;

  let closestIndex = 0;
  let closestDifferenceMs = Infinity;

  times.forEach((time, index) => {
    const forecastTimeMs = new Date(time).getTime();
    const differenceMs = Math.abs(forecastTimeMs - targetTimeMs);

    if (differenceMs < closestDifferenceMs) {
      closestDifferenceMs = differenceMs;
      closestIndex = index;
    }
  });

  return closestIndex;
}

function mapOpenMeteoToWindLayers(
  data: OpenMeteoResponse,
  forecastHourOffset: number
): WindLayer[] {
  const hourly = data.hourly;

  if (!hourly) {
    throw new Error("Open-Meteo response did not include hourly data.");
  }

  const index = getOpenMeteoHourlyIndex(data, forecastHourOffset);

  const altitudeLevels = Object.values(openMeteoPressureAltitudeM);

  const directionsByAltitude: Record<string, number> = {
    [String(openMeteoPressureAltitudeM["1000"])]:
      hourly.wind_direction_1000hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["925"])]:
      hourly.wind_direction_925hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["850"])]:
      hourly.wind_direction_850hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["700"])]:
      hourly.wind_direction_700hPa?.[index] ?? 0,
  };

  const speedsByAltitude: Record<string, number> = {
    [String(openMeteoPressureAltitudeM["1000"])]:
      hourly.wind_speed_1000hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["925"])]:
      hourly.wind_speed_925hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["850"])]:
      hourly.wind_speed_850hPa?.[index] ?? 0,
    [String(openMeteoPressureAltitudeM["700"])]:
      hourly.wind_speed_700hPa?.[index] ?? 0,
  };

  return altitudes.map((altitudeM) => {
    const directionFromDeg = interpolateDirection(
      altitudeM,
      altitudeLevels,
      directionsByAltitude
    );

    const speedKt = interpolateNumber(
      altitudeM,
      altitudeLevels,
      speedsByAltitude
    );

    return {
      altitudeM,
      directionFromDeg: String(Math.round(directionFromDeg)),
      speedKt: String(Math.round(speedKt)),
    };
  });
}

function mapMarkSchulzeToWindLayers(data: MarkSchulzeResponse): WindLayer[] {
  if (!data.altSI || !data.directionSI || !data.speedSI) {
    throw new Error(
      "Mark Schulze response did not include altSI, directionSI, and speedSI."
    );
  }

  return altitudes.map((altitudeM) => {
    const directionFromDeg = interpolateDirection(
      altitudeM,
      data.altSI ?? [],
      data.directionSI ?? {}
    );

    const speedKmh = interpolateNumber(
      altitudeM,
      data.altSI ?? [],
      data.speedSI ?? {}
    );

    return {
      altitudeM,
      directionFromDeg: String(Math.round(directionFromDeg)),
      speedKt: String(Math.round(kmhToKt(speedKmh))),
    };
  });
}

function mapMeteomaticsToWindLayers(data: MeteomaticsProxyResponse): WindLayer[] {
  if (Array.isArray(data.winds) && data.winds.length > 0) {
    return data.winds.map((wind) => ({
      altitudeM: wind.altitudeM,
      directionFromDeg: String(Math.round(numberFromInput(wind.directionFromDeg, 0))),
      speedKt: String(Math.round(numberFromInput(wind.speedKt, 0))),
    }));
  }

  return mapMarkSchulzeToWindLayers(data);
}

function buildWindyUrl(lat: number, lon: number): string {
  return `https://www.windy.com/?wind,${lat.toFixed(4)},${lon.toFixed(4)},10`;
}

function preventSpeedIncreasesThroughWindow(rows: ResultRow[]): ResultRow[] {
  let previousSpeed: number | null = null;

  return rows.map((row) => {
    if (row.targetSpeedKph === undefined) return row;

    if (previousSpeed === null) {
      previousSpeed = row.targetSpeedKph;
      return row;
    }

    const cappedSpeed = Math.min(row.targetSpeedKph, previousSpeed);
    previousSpeed = cappedSpeed;

    return {
      ...row,
      targetSpeedKph: cappedSpeed,
    };
  });
}

function calculateTargets(
  taskMode: TaskMode,
  zeroWindSpeedKph: number,
  startGR: number,
  endGR: number,
  runHeadingDeg: number,
  winds: WindLayer[]
): ResultRow[] {
  const components = winds.map((wind) =>
    windComponents(
      runHeadingDeg,
      numberFromInput(wind.directionFromDeg, 0),
      numberFromInput(wind.speedKt, 0)
    )
  );

  const tailwindsKt = components.map((component) => component.tailwindKt);

  const rawRows = winds.map((wind, index) => {
    const tailwindKt = components[index].tailwindKt;
    const crosswindKt = components[index].crosswindKt;

    if (taskMode === "speed") {
      const effectiveWindAheadKt = leastFavorableWindAhead(index, tailwindsKt);
      const baseGR = baseGRAtAltitude(wind.altitudeM, startGR, endGR);
      const correctionProgress = Math.min(
        Math.max((2500 - wind.altitudeM) / 1000, 0),
        1
      );

      const targetGR =
        baseGR + grWindCorrection(effectiveWindAheadKt) * correctionProgress;

      return {
        altitudeM: wind.altitudeM,
        tailwindKt: Math.round(tailwindKt),
        crosswindKt: Math.round(crosswindKt),
        effectiveWindAheadKt: Math.round(effectiveWindAheadKt),
        targetGR: Number(targetGR.toFixed(2)),
      };
    }

    if (taskMode === "time") {
      const targetSpeedKph =
        zeroWindSpeedKph +
        blendedTimeWindCorrectionKph(tailwindKt, crosswindKt) -
        delayedPerformanceDropKph(wind.altitudeM);

      return {
        altitudeM: wind.altitudeM,
        tailwindKt: Math.round(tailwindKt),
        crosswindKt: Math.round(crosswindKt),
        targetSpeedKph: Math.round(targetSpeedKph),
      };
    }

    const targetSpeedKph =
      zeroWindSpeedKph +
      distanceWindCorrectionKph(tailwindKt, crosswindKt) -
      delayedPerformanceDropKph(wind.altitudeM);

    return {
      altitudeM: wind.altitudeM,
      tailwindKt: Math.round(tailwindKt),
      crosswindKt: Math.round(crosswindKt),
      targetSpeedKph: Math.round(targetSpeedKph),
    };
  });

  if (taskMode === "speed") return rawRows;

  return preventSpeedIncreasesThroughWindow(rawRows);
}

function HeadingSlider({
  runHeadingDeg,
  windAdvantage,
  windSourceUnavailable,
  onInteractionStart,
  onInteractionEnd,
  onChange,
}: {
  runHeadingDeg: string;
  windAdvantage: WindAdvantageSummary;
  windSourceUnavailable: boolean;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
  onChange: (value: string) => void;
}) {  
  
  const heading = Math.round(numberFromInput(runHeadingDeg, 0));
  const averageTailwind = Math.round(windAdvantage.averageTailwindKt);
  const bestTailwind = Math.round(windAdvantage.bestAverageTailwindKt);

  return (
    <div className="heading-slider-panel">
      <div className="heading-slider-readout">
        Flight heading:{" "}
        <strong>{runHeadingDeg.trim() === "" ? "---" : `${heading}°`}</strong>
      </div>

      <input
        className="heading-slider"
        type="range"
        min="0"
        max="359"
        step="1"
        value={numberFromInput(runHeadingDeg, 0)}
        onPointerDown={() => onInteractionStart()}
        onPointerUp={() => onInteractionEnd()}
        onPointerCancel={() => onInteractionEnd()}
        onTouchEnd={() => onInteractionEnd()}
        onMouseUp={() => onInteractionEnd()}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="heading-slider-scale">
        <span>000°</span>
        <span>090°</span>
        <span>180°</span>
        <span>270°</span>
        <span>359°</span>
      </div>

      <p className="subtitle">
        {windSourceUnavailable ? (
          "Current wind source unavailable, please choose new wind source."
        ) : (
          <>
            Wind advantage: {averageTailwind >= 0 ? "+" : ""}
            {averageTailwind} kt average. Best heading about{" "}
            {windAdvantage.bestHeadingDeg}° gives {bestTailwind >= 0 ? "+" : ""}
            {bestTailwind} kt.
          </>
        )}
      </p>
    </div>
  );
}

function MapViewportUpdater({
  referenceLat,
  referenceLon,
  userMapLocation,
  savedReferencePoints,
  trackPoints,
}: {
  referenceLat: string;
  referenceLon: string;
  userMapLocation: LatLon | null;
  savedReferencePoints: SavedReferencePoint[];
  trackPoints: GpsTrackPoint[];
}) {
  const map = useMap();
  const lastViewportTargetKey = useRef("");
  const viewportTargetKey = [
    referenceLat,
    referenceLon,
    userMapLocation === null
      ? ""
      : `${userMapLocation.lat},${userMapLocation.lon}`,
    savedReferencePoints
      .map((point) => `${point.id}:${point.lat},${point.lon}`)
      .join("|"),
    trackPoints.map((point) => `${point.lat},${point.lon}`).join("|"),
  ].join(";");

  useEffect(() => {
    if (lastViewportTargetKey.current === viewportTargetKey) {
      return;
    }

    lastViewportTargetKey.current = viewportTargetKey;

    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat !== null && lon !== null) {
      if (trackPoints.length > 0) {
        map.fitBounds(
          [
            [lat, lon] as [number, number],
            ...trackPoints.map(
              (point) => [point.lat, point.lon] as [number, number],
            ),
          ],
          {
            padding: [36, 36],
            maxZoom: 14,
          },
        );
        return;
      }

      map.setView([lat, lon], 12);
      return;
    }

    const savedLocationViewportPoints =
      savedReferencePoints.length > 0
        ? [...savedReferencePoints, ...trackPoints]
        : [];

    if (savedLocationViewportPoints.length === 1) {
      const [point] = savedLocationViewportPoints;
      map.setView([point.lat, point.lon], 14);
      return;
    }

    if (savedLocationViewportPoints.length > 1) {
      map.fitBounds(
        savedLocationViewportPoints.map(
          (point) => [point.lat, point.lon] as [number, number],
        ),
        {
          padding: [36, 36],
          maxZoom: 14,
        },
      );
      return;
    }

    if (userMapLocation !== null) {
      map.setView([userMapLocation.lat, userMapLocation.lon], 13);
    }
  });

  return null;
}

function MapClickPicker({
  referenceLat,
  referenceLon,
  userMapLocation,
  dropPoint,
  runHeadingDeg,
  laneColor = "#22c55e",
  trackPoints = NO_TRACK_POINTS,
  savedReferencePoints = NO_SAVED_REFERENCE_POINTS,
  onSavedReferencePointPick,
  onPick,
}: {
  referenceLat: string;
  referenceLon: string;
  userMapLocation: LatLon | null;
  dropPoint: LatLon | null;
  runHeadingDeg: string;
  laneColor?: string;
  trackPoints?: GpsTrackPoint[];
  savedReferencePoints?: SavedReferencePoint[];
  onSavedReferencePointPick?: (point: SavedReferencePoint) => void;
  onPick: (lat: number, lon: number) => void;
}) {
  const lat = optionalNumberFromInput(referenceLat);
  const lon = optionalNumberFromInput(referenceLon);

  const hasReferencePoint = lat !== null && lon !== null;
  const hasUserMapLocation = userMapLocation !== null;

  const center: [number, number] = hasReferencePoint
    ? [lat, lon]
    : savedReferencePoints.length > 0
      ? [savedReferencePoints[0].lat, savedReferencePoints[0].lon]
    : hasUserMapLocation
      ? [userMapLocation.lat, userMapLocation.lon]
      : [20, 0];

  const initialZoom =
    hasReferencePoint || savedReferencePoints.length > 0
      ? 12
      : hasUserMapLocation
        ? 13
        : 2;

  const selectedSavedReferencePointId =
    lat !== null && lon !== null
      ? (savedReferencePoints.find(
          (point) =>
            Math.abs(point.lat - lat) < 0.000001 &&
            Math.abs(point.lon - lon) < 0.000001,
        )?.id ?? null)
      : null;

  function ClickHandler() {
    useMapEvents({
      click(event) {
        onPick(event.latlng.lat, event.latlng.lng);
      },
    });

    return null;
  }


  const trackPositions: [number, number][] = trackPoints.map((point) => [
    point.lat,
    point.lon,
  ]);

  const headingNumber = optionalNumberFromInput(runHeadingDeg);

  const canBuildLane =
    dropPoint !== null &&
    lat !== null &&
    lon !== null &&
    headingNumber !== null;

  const leftRedLanePolygon: [number, number][] = canBuildLane
    ? buildLaneStripPolygon(
        dropPoint,
        { lat, lon },
        headingNumber,
        450,
        600,
        "left"
      )
    : [];

  const leftYellowLanePolygon: [number, number][] = canBuildLane
    ? buildLaneStripPolygon(
        dropPoint,
        { lat, lon },
        headingNumber,
        300,
        450,
        "left"
      )
    : [];

  const rightYellowLanePolygon: [number, number][] = canBuildLane
    ? buildLaneStripPolygon(
        dropPoint,
        { lat, lon },
        headingNumber,
        300,
        450,
        "right"
      )
    : [];

  const rightRedLanePolygon: [number, number][] = canBuildLane
    ? buildLaneStripPolygon(
        dropPoint,
        { lat, lon },
        headingNumber,
        450,
        600,
        "right"
      )
    : [];

  const greenLanePolygon: [number, number][] = canBuildLane
    ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 300)
    : [];

  return (
    <div className="map-picker">
      <MapContainer center={center} zoom={initialZoom} scrollWheelZoom={true}>
        <MapViewportUpdater
          referenceLat={referenceLat}
          referenceLon={referenceLon}
          userMapLocation={userMapLocation}
          savedReferencePoints={savedReferencePoints}
          trackPoints={trackPoints}
        />

        <TileLayer
          attribution="Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />

        <ClickHandler />

        {userMapLocation !== null && !hasReferencePoint && (
          <Marker
            position={[userMapLocation.lat, userMapLocation.lon]}
            icon={userLocationIcon}
          />
        )}

        {leftRedLanePolygon.length === 4 && (
          <Polygon
            positions={leftRedLanePolygon}
            pathOptions={{
              color: "#ef4444",
              weight: 1,
              opacity: 0.85,
              fillColor: "#ef4444",
              fillOpacity: 0.18,
            }}
          />
        )}

        {rightRedLanePolygon.length === 4 && (
          <Polygon
            positions={rightRedLanePolygon}
            pathOptions={{
              color: "#ef4444",
              weight: 1,
              opacity: 0.85,
              fillColor: "#ef4444",
              fillOpacity: 0.18,
            }}
          />
        )}

        {leftYellowLanePolygon.length === 4 && (
          <Polygon
            positions={leftYellowLanePolygon}
            pathOptions={{
              color: "#facc15",
              weight: 1,
              opacity: 0.9,
              fillColor: "#facc15",
              fillOpacity: 0.22,
            }}
          />
        )}

        {rightYellowLanePolygon.length === 4 && (
          <Polygon
            positions={rightYellowLanePolygon}
            pathOptions={{
              color: "#facc15",
              weight: 1,
              opacity: 0.9,
              fillColor: "#facc15",
              fillOpacity: 0.22,
            }}
          />
        )}

        {greenLanePolygon.length === 4 && (
          <Polygon
            positions={greenLanePolygon}
            pathOptions={{
              color: laneColor,
              weight: 3,
              opacity: 0.95,
              fillOpacity: 0,
            }}
          />
        )}

        {dropPoint !== null && lat !== null && lon !== null && (
          <Polyline
            positions={[
              [dropPoint.lat, dropPoint.lon],
              [lat, lon],
            ]}
            pathOptions={{
              color: laneColor,
              weight: 4,
              opacity: 0.95,
            }}
          />
        )}

        {dropPoint !== null && (
          <Marker
            position={[dropPoint.lat, dropPoint.lon]}
            icon={dropPointIcon}
          />
        )}

        {lat !== null && lon !== null && !selectedSavedReferencePointId && (
          <Marker position={[lat, lon]} icon={referencePointIcon} />
        )}

        {savedReferencePoints.map((point, index) => (
          <Marker
            key={point.id}
            position={[point.lat, point.lon]}
            icon={savedReferencePointMapIcon(
              index,
              point.id === selectedSavedReferencePointId,
            )}
            eventHandlers={{
              click: () => onSavedReferencePointPick?.(point),
            }}
          >
            <LeafletTooltip
              className="saved-reference-map-tooltip"
              direction="top"
              offset={[0, -14]}
              permanent
            >
              {index + 1}. {point.name}
            </LeafletTooltip>
          </Marker>
        ))}

        {trackPositions.length > 1 && (
          <Polyline
            positions={trackPositions}
            pathOptions={{
              color: "#22d3ee",
              weight: 4,
              opacity: 0.95,
            }}
          />
        )}

      </MapContainer>
    </div>
  );
}

function LaneViewMap({
  referenceLat,
  referenceLon,
  dropPoint,
  runHeadingDeg,
  dropDistanceNm,
  winds,
}: {
  referenceLat: string;
  referenceLon: string;
  dropPoint: LatLon | null;
  runHeadingDeg: string;
  dropDistanceNm: string;
  winds: WindLayer[];
}) {
  
  const mapContainerRef = useMemo(
    () => ({ current: null as HTMLDivElement | null }),
    []
  );

  useEffect(() => {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);
    const headingNumber = optionalNumberFromInput(runHeadingDeg);

    if (
      lat === null ||
      lon === null ||
      dropPoint === null ||
      headingNumber === null ||
      mapContainerRef.current === null
    ) {
      return;
    }

    const referencePoint = { lat, lon };

    const center: [number, number] = [
      (lon + dropPoint.lon) / 2,
      (lat + dropPoint.lat) / 2,
    ];

    function toMapLibrePolygon(points: [number, number][]) {
      return points.map(([pointLat, pointLon]) => [pointLon, pointLat]);
    }

    function makePolygonFeature(points: [number, number][]) {
      return {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[...toMapLibrePolygon(points), toMapLibrePolygon(points)[0]]],
        },
      };
    }

    const leftRedLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      450,
      600,
      "left"
    );

    const rightRedLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      450,
      600,
      "right"
    );

    const leftYellowLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300,
      450,
      "left"
    );

    const rightYellowLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300,
      450,
      "right"
    );

    const greenLanePolygon = buildLanePolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300
    );

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: [
              "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            attribution:
              "Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          },
        },
        layers: [
          {
            id: "satellite",
            type: "raster",
            source: "satellite",
          },
        ],
      },
      center,
      zoom: 12,
      bearing: headingNumber,
      pitch: 0,
    });

    let handleLaneWheel: ((event: WheelEvent) => void) | null = null;
    map.on("load", () => {
      const windMarkerSideBearing = normalizeDeg(headingNumber - 90);
      const laneLengthM = nmToMetres(numberFromInput(dropDistanceNm, 0));

      const bounds = new maplibregl.LngLatBounds();

      [
        ...leftRedLanePolygon,
        ...rightRedLanePolygon,
        ...leftYellowLanePolygon,
        ...rightYellowLanePolygon,
        ...greenLanePolygon,
      ].forEach(([pointLat, pointLon]) => {
        bounds.extend([pointLon, pointLat]);
      });

      winds.forEach((wind) => {
        const segmentProgress = Math.min(
          Math.max((2500 - wind.altitudeM) / 1000, 0),
          1
        );

        const lanePoint = destinationPoint(
          dropPoint.lat,
          dropPoint.lon,
          headingNumber,
          laneLengthM * segmentProgress
        );

        const windEdgePoint = destinationPoint(
          lanePoint.lat,
          lanePoint.lon,
          windMarkerSideBearing,
          600
        );

        bounds.extend([windEdgePoint.lon, windEdgePoint.lat]);
      });

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          padding: {
            top: 45,
            bottom: 85,
            left: 105,
            right: 25,
          },
          duration: 0,
        });

        map.setBearing(headingNumber);
        map.setPitch(0);

        const laneCenter = bounds.getCenter();

        map.scrollZoom.disable();

        handleLaneWheel = (event: WheelEvent) => {
          event.preventDefault();

          const zoomStep = 0.12;
          const direction = event.deltaY > 0 ? -1 : 1;

          const nextZoom = Math.max(
            map.getMinZoom(),
            Math.min(map.getMaxZoom(), map.getZoom() + direction * zoomStep)
          );

          map.easeTo({
            center: laneCenter,
            zoom: nextZoom,
            bearing: headingNumber,
            pitch: 0,
            duration: 100,
          });
        };

        map
          .getCanvasContainer()
          .addEventListener("wheel", handleLaneWheel, {
            passive: false,
          });
      }
      map.addSource("lane-red-left", {
        type: "geojson",
        data: makePolygonFeature(leftRedLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-red-right", {
        type: "geojson",
        data: makePolygonFeature(rightRedLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-yellow-left", {
        type: "geojson",
        data: makePolygonFeature(leftYellowLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-yellow-right", {
        type: "geojson",
        data: makePolygonFeature(rightYellowLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-green-outline", {
        type: "geojson",
        data: makePolygonFeature(greenLanePolygon) as GeoJSON.Feature,
      });

      map.addLayer({
        id: "lane-red-left-fill",
        type: "fill",
        source: "lane-red-left",
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.18,
        },
      });

      map.addLayer({
        id: "lane-red-right-fill",
        type: "fill",
        source: "lane-red-right",
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.18,
        },
      });

      map.addLayer({
        id: "lane-yellow-left-fill",
        type: "fill",
        source: "lane-yellow-left",
        paint: {
          "fill-color": "#facc15",
          "fill-opacity": 0.22,
        },
      });

      map.addLayer({
        id: "lane-yellow-right-fill",
        type: "fill",
        source: "lane-yellow-right",
        paint: {
          "fill-color": "#facc15",
          "fill-opacity": 0.22,
        },
      });

      map.addLayer({
        id: "lane-green-outline-line",
        type: "line",
        source: "lane-green-outline",
        paint: {
          "line-color": "#22c55e",
          "line-width": 3,
          "line-opacity": 0.95,
        },
      });

      const mapBearingDeg = normalizeDeg(headingNumber + 180);

      winds.forEach((wind) => {
        const segmentProgress = Math.min(
          Math.max((2500 - wind.altitudeM) / 1000, 0),
          1
        );

        const lanePoint = destinationPoint(
          dropPoint.lat,
          dropPoint.lon,
          headingNumber,
          laneLengthM * segmentProgress
        );

        const markerPoint = destinationPoint(
          lanePoint.lat,
          lanePoint.lon,
          windMarkerSideBearing,
          600
        );

        const windSpeedKt = Math.round(numberFromInput(wind.speedKt, 0));
        const windFromDeg = Math.round(numberFromInput(wind.directionFromDeg, 0));

        // Show the direction the wind is travelling toward, corrected for the rotated map.
        const windTowardDeg = normalizeDeg(windFromDeg + 180);
        const windScreenRotationDeg =
          signedAngleDeg(mapBearingDeg, windTowardDeg) + 90;

        const markerElement = document.createElement("div");
        markerElement.className = "lane-wind-marker";
        markerElement.innerHTML = `
          <div class="lane-wind-speed">${windSpeedKt} kt</div>
          <div
            class="lane-wind-arrow"
            style="transform: rotate(${windScreenRotationDeg}deg);"
          >
            ➜
          </div>
        `;
        new maplibregl.Marker({
          element: markerElement,
          rotationAlignment: "viewport",
          anchor: "right",
          offset: [-8, 0],
})
  .setLngLat([markerPoint.lon, markerPoint.lat])
  .addTo(map);
      });

      new maplibregl.Marker({ color: "#22d3ee" })
        .setLngLat([lon, lat])
        .addTo(map);
    });

    return () => {
      map.remove();
    };
  }, [
  referenceLat,
  referenceLon,
  dropPoint,
  runHeadingDeg,
  dropDistanceNm,
  winds,
  mapContainerRef,
]);

  return <div ref={mapContainerRef} className="lane-view-map" />;
}

function TargetGraph({
  taskMode,
  results,
}: {
  taskMode: TaskMode;
  results: ResultRow[];
}) {
  const values = results.map((row) =>
    taskMode === "speed" ? row.targetGR ?? 0 : row.targetSpeedKph ?? 0
  );

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  const chartMin =
    taskMode === "speed" ? Math.floor(minValue * 2) / 2 : minValue - 5;

  const chartMax =
    taskMode === "speed" ? Math.ceil(maxValue * 2) / 2 : maxValue + 5;

  const range = chartMax - chartMin || 1;

  const width = 620;
  const height = 360;
  const leftPad = 58;
  const rightPad = 24;
  const topPad = 28;
  const bottomPad = 48;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;

  function xFromAltitude(altitudeM: number): number {
    const progress = (2500 - altitudeM) / 1000;
    return leftPad + progress * plotWidth;
  }

  function yFromValue(value: number): number {
    return topPad + (1 - (value - chartMin) / range) * plotHeight;
  }

  function smoothPath(points: { x: number; y: number }[]): string {
    if (points.length < 2) return "";

    const commands = [`M ${points[0].x} ${points[0].y}`];

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const midX = (previous.x + current.x) / 2;

      commands.push(
        `C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`
      );
    }

    return commands.join(" ");
  }

  const points = results.map((row) => {
    const value =
      taskMode === "speed" ? row.targetGR ?? 0 : row.targetSpeedKph ?? 0;

    return {
      x: xFromAltitude(row.altitudeM),
      y: yFromValue(value),
      value,
      altitudeM: row.altitudeM,
    };
  });

  const valueLabel = taskMode === "speed" ? "Target GR" : "Target speed km/h";

  const yTicks =
    taskMode === "speed"
      ? Array.from(
          { length: Math.round((chartMax - chartMin) / 0.5) + 1 },
          (_, index) => Number((chartMin + index * 0.5).toFixed(1))
        )
      : [chartMin, (chartMin + chartMax) / 2, chartMax];

  return (
    <section className="card">
      <h2>Window Graph</h2>

      <div className="graph-wrap">
        <svg
          className="target-graph"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Target graph"
        >
          <line
            x1={leftPad}
            y1={topPad}
            x2={leftPad}
            y2={topPad + plotHeight}
            className="axis"
          />

          <line
            x1={leftPad}
            y1={topPad + plotHeight}
            x2={leftPad + plotWidth}
            y2={topPad + plotHeight}
            className="axis"
          />

          {[2500, 2000, 1500].map((altitude) => {
            const x = xFromAltitude(altitude);

            return (
              <g key={altitude}>
                <line
                  x1={x}
                  y1={topPad}
                  x2={x}
                  y2={topPad + plotHeight}
                  className="grid"
                />
                <text
                  x={x}
                  y={height - 18}
                  textAnchor="middle"
                  className="graph-label"
                >
                  {altitude} m
                </text>
              </g>
            );
          })}

          {yTicks.map((tick, index) => {
            const y = yFromValue(tick);

            return (
              <g key={index}>
                <line
                  x1={leftPad}
                  y1={y}
                  x2={leftPad + plotWidth}
                  y2={y}
                  className="grid"
                />
                <text
                  x={leftPad - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="graph-label"
                >
                  {taskMode === "speed" ? tick.toFixed(1) : Math.round(tick)}
                </text>
              </g>
            );
          })}

          <path d={smoothPath(points)} className="target-line" />

          {points.map((point) => (
            <g key={point.altitudeM}>
              <circle cx={point.x} cy={point.y} r={4} className="target-dot" />
              <text
                x={point.x}
                y={point.y - 8}
                textAnchor="middle"
                className="point-label"
              >
                {taskMode === "speed"
                  ? point.value.toFixed(2)
                  : Math.round(point.value)}
              </text>
            </g>
          ))}

          <text
            x={leftPad + plotWidth / 2}
            y={height - 4}
            textAnchor="middle"
            className="graph-title"
          >
            Altitude
          </text>

          <text
            x={18}
            y={topPad + plotHeight / 2}
            textAnchor="middle"
            className="graph-title"
            transform={`rotate(-90 18 ${topPad + plotHeight / 2})`}
          >
            {valueLabel}
          </text>
        </svg>
      </div>
    </section>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchText(text: string, query: string) {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2);

  if (words.length === 0) {
    return text;
  }

  const pattern = words.map(escapeRegExp).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, index) =>
    regex.test(part) ? (
      <mark className="rules-search-highlight" key={`${part}-${index}`}>
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function getSearchWords(query: string) {
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word.length >= 3);
}

function ruleMatchesSearchWords(
  rule: {
    id: string;
    title: string;
    text: string;
    searchTerms?: string[];
  },
  query: string
) {
  const words = getSearchWords(query);

  if (words.length === 0) {
    return true;
  }

  const haystack = [
    rule.id,
    rule.title,
    rule.text,
    ...(rule.searchTerms ?? []),
  ]
    .join(" ")
    .toLowerCase();

  return words.every((word) => {
    const plural = `${word}s`;
    const withoutPlural = word.endsWith("s") ? word.slice(0, -1) : word;
    const softStem = word.length >= 5 ? word.replace(/e$/, "") : word;

    return (
      haystack.includes(word) ||
      haystack.includes(plural) ||
      haystack.includes(withoutPlural) ||
      haystack.includes(softStem)
    );
  });
}

function BottomBackButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <section className="bottom-nav">
      <button type="button" className="primary-action-button" onClick={onClick}>
        {label}
      </button>
    </section>
  );
}

function InteractiveTrackChart({
  points,
  windowOffsetM,
  winds,
  graphView,
  onGraphViewChange,
  scoreMode,
  onScoreModeChange,
  showCompetitionContext = true,
  showScoreModeControl = showCompetitionContext,
}: {
  points: GpsTrackPoint[];
  windowOffsetM: number;
  winds: WindLayer[];
  graphView: "comp" | "full";
  onGraphViewChange: (view: "comp" | "full") => void;
  scoreMode: "raw" | "corrected";
  onScoreModeChange: (mode: "raw" | "corrected") => void;
  showCompetitionContext?: boolean;
  showScoreModeControl?: boolean;
}) {
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

const chartData = points.map((point, index) => {
  const diveAngleDeg =
    point.horizontalSpeedMps > 0
      ? Math.atan2(
          point.verticalSpeedMps,
          point.horizontalSpeedMps
        ) *
        (180 / Math.PI)
      : 0;

  const windDirectionFromDeg =
    winds.length > 0
      ? interpolateDirection(
          point.altitudeM,
          windAltitudes,
          windDirectionsByAltitude
        )
      : 0;

  const windSpeedKt =
    winds.length > 0
      ? interpolateNumber(
          point.altitudeM,
          windAltitudes,
          windSpeedsByAltitude
        )
      : 0;

  const windTowardDeg = normalizeDeg(windDirectionFromDeg + 180);
  const windSpeedMps = windSpeedKt * 0.514444;
  const windTowardRad = degToRad(windTowardDeg);

  const windNorthMps = Math.cos(windTowardRad) * windSpeedMps;
  const windEastMps = Math.sin(windTowardRad) * windSpeedMps;

  const airNorthMps = point.velNMps - windNorthMps;
  const airEastMps = point.velEMps - windEastMps;

  const calculatedAirspeedMps = Math.sqrt(
    airNorthMps * airNorthMps + airEastMps * airEastMps
  );

  const useCorrectedGraphValues = scoreMode === "corrected" && winds.length > 0;

const displayHorizontalSpeedMps = getDisplayHorizontalSpeedMps(
  point,
  winds,
  useCorrectedGraphValues
);

const displayTotalSpeedMps = getDisplayTotalSpeedMps(
  point,
  winds,
  useCorrectedGraphValues
);

const displayGlideRatio = getDisplayGlideRatio(
  point,
  winds,
  useCorrectedGraphValues
);

  return {
    sample: index,
    timeSeconds: index * GPS_SAMPLE_PERIOD_SECONDS,
    altitudeM: point.altitudeM,
    horizontalSpeedKmh: metresPerSecondToKmh(
      displayHorizontalSpeedMps),
    verticalSpeedKmh: metresPerSecondToKmh(
      point.verticalSpeedMps
    ),
    totalSpeedKmh: metresPerSecondToKmh(
      displayTotalSpeedMps),
    calculatedAirspeedKmh: metresPerSecondToKmh(
      calculatedAirspeedMps
    ),
    glideRatio: displayGlideRatio,
    diveAngleDeg,
    windDirectionFromDeg,
    windSpeedKt,
  };
});

  type ChartMouseState = {
    activeLabel?: string | number;
  };

  type TouchPoint = {
    x: number;
    y: number;
  };

  const totalMinTime = chartData[0]?.timeSeconds ?? 0;
  const lastTime = chartData.at(-1)?.timeSeconds ?? totalMinTime;
  const totalMaxTime = lastTime > totalMinTime ? lastTime : totalMinTime + 1;
  const totalTimeSpan = totalMaxTime - totalMinTime;
  const PINCH_ZOOM_SENSITIVITY = 2.6;
  const minimumZoomSpan = Math.max(totalTimeSpan / 500, GPS_SAMPLE_PERIOD_SECONDS * 8);
  const [visibleDomain, setVisibleDomain] = useState<[number, number] | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [isPinching, setIsPinching] = useState(false);
  const touchPointsRef = useRef<Map<number, TouchPoint>>(new Map());
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartDomainRef = useRef<[number, number] | null>(null);
  const pendingPinchDomainRef = useRef<[number, number] | null>(null);

  const trackRangeKey =
    String(points.length) + ":" +
    String(points[0]?.timestampMs ?? "start") + ":" +
    String(points.at(-1)?.timestampMs ?? "end");

  useEffect(() => {
    setVisibleDomain(null);
    setSelectionStart(null);
    setSelectionEnd(null);
    setIsPinching(false);
    touchPointsRef.current.clear();
    pinchStartDistanceRef.current = null;
    pinchStartDomainRef.current = null;
    pendingPinchDomainRef.current = null;
  }, [trackRangeKey]);

  const activeDomain = visibleDomain ?? [totalMinTime, totalMaxTime];
  const isZoomed =
    activeDomain[0] > totalMinTime || activeDomain[1] < totalMaxTime;

  function clampDomain(start: number, end: number): [number, number] {
    let nextStart = Math.max(totalMinTime, Math.min(start, totalMaxTime));
    let nextEnd = Math.max(totalMinTime, Math.min(end, totalMaxTime));

    if (nextEnd - nextStart < minimumZoomSpan) {
      const center = (nextStart + nextEnd) / 2;
      nextStart = center - minimumZoomSpan / 2;
      nextEnd = center + minimumZoomSpan / 2;
    }

    if (nextStart < totalMinTime) {
      nextEnd += totalMinTime - nextStart;
      nextStart = totalMinTime;
    }

    if (nextEnd > totalMaxTime) {
      nextStart -= nextEnd - totalMaxTime;
      nextEnd = totalMaxTime;
    }

    return [
      Math.max(totalMinTime, nextStart),
      Math.min(totalMaxTime, nextEnd),
    ];
  }

  function getZoomDomain(
    centerTime: number,
    scale: number,
    domain: [number, number] = activeDomain
  ): [number, number] {
    const [currentStart, currentEnd] = domain;
    const currentSpan = currentEnd - currentStart;
    const nextSpan = Math.max(
      minimumZoomSpan,
      Math.min(totalTimeSpan, currentSpan * scale)
    );
    const centerRatio =
      currentSpan > 0 ? (centerTime - currentStart) / currentSpan : 0.5;
    const nextStart = centerTime - nextSpan * centerRatio;
    const nextEnd = nextStart + nextSpan;
    return clampDomain(nextStart, nextEnd);
  }

  function zoomAround(centerTime: number, scale: number) {
    setVisibleDomain(getZoomDomain(centerTime, scale));
  }

  function getChartPlotBounds(chartElement: HTMLDivElement) {
    const svg = chartElement.querySelector("svg");
    const gridLine = chartElement.querySelector(
      ".recharts-cartesian-grid-horizontal line"
    );

    if (!(svg instanceof SVGSVGElement) || !(gridLine instanceof SVGLineElement)) {
      const rect = chartElement.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    }

    const svgRect = svg.getBoundingClientRect();
    const viewBoxWidth = svg.viewBox.baseVal.width || svgRect.width;
    const scaleX = svgRect.width / viewBoxWidth;
    const x1 = Number(gridLine.getAttribute("x1"));
    const x2 = Number(gridLine.getAttribute("x2"));

    if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) {
      return { left: svgRect.left, width: svgRect.width };
    }

    return {
      left: svgRect.left + x1 * scaleX,
      width: (x2 - x1) * scaleX,
    };
  }

  function getTimeFromChartPosition(
    clientX: number,
    chartElement: HTMLDivElement,
    domain: [number, number] = activeDomain
  ) {
    const plotBounds = getChartPlotBounds(chartElement);
    const progress = Math.max(
      0,
      Math.min(1, (clientX - plotBounds.left) / plotBounds.width)
    );
    return domain[0] + progress * (domain[1] - domain[0]);
  }

  function getNumericLabel(state: ChartMouseState | undefined) {
    const value = Number(state?.activeLabel);
    return Number.isFinite(value) ? value : null;
  }

  function handleChartMouseDown(state: ChartMouseState | undefined) {
    const label = getNumericLabel(state);

    if (label === null) {
      return;
    }

    setSelectionStart(label);
    setSelectionEnd(label);
  }

  function handleChartMouseMove(state: ChartMouseState | undefined) {
    if (selectionStart === null) {
      return;
    }

    const label = getNumericLabel(state);

    if (label !== null) {
      setSelectionEnd(label);
    }
  }

  function finishChartSelection() {
    if (selectionStart === null || selectionEnd === null) {
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    const nextStart = Math.min(selectionStart, selectionEnd);
    const nextEnd = Math.max(selectionStart, selectionEnd);

    if (nextEnd - nextStart >= minimumZoomSpan) {
      setVisibleDomain(clampDomain(nextStart, nextEnd));
    }

    setSelectionStart(null);
    setSelectionEnd(null);
  }

  function resetZoom() {
    setVisibleDomain(null);
    setSelectionStart(null);
    setSelectionEnd(null);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const centerTime = getTimeFromChartPosition(event.clientX, event.currentTarget);
    const wheelStep = Math.max(-1, Math.min(1, event.deltaY / 240));
    const scale = Math.exp(wheelStep * 0.012);
    zoomAround(centerTime, scale);
  }

  function previewPinchDomain(chartElement: HTMLDivElement) {
    const nextDistance = getTouchDistance();
    const startDistance = pinchStartDistanceRef.current;
    const startDomain = pinchStartDomainRef.current;

    if (nextDistance === null || startDistance === null || startDomain === null) {
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    const centerClientX = getTouchCenterX();
    const centerTime = getTimeFromChartPosition(
      centerClientX,
      chartElement,
      startDomain
    );
    const distanceRatio = nextDistance / startDistance;
    const zoomScale = Math.pow(distanceRatio, PINCH_ZOOM_SENSITIVITY);
    const nextDomain = getZoomDomain(centerTime, zoomScale, startDomain);
    pendingPinchDomainRef.current = nextDomain;
    setSelectionStart(nextDomain[0]);
    setSelectionEnd(nextDomain[1]);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return;
    }

    touchPointsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (touchPointsRef.current.size >= 2) {
      setIsPinching(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      pinchStartDistanceRef.current = getTouchDistance();
      pinchStartDomainRef.current = activeDomain;
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || !touchPointsRef.current.has(event.pointerId)) {
      return;
    }

    touchPointsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (touchPointsRef.current.size < 2) {
      return;
    }

    const nextDistance = getTouchDistance();

    if (nextDistance === null || nextDistance <= 0) {
      return;
    }

    event.preventDefault();
    previewPinchDomain(event.currentTarget);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return;
    }

    touchPointsRef.current.delete(event.pointerId);

    if (touchPointsRef.current.size < 2) {
      if (pendingPinchDomainRef.current) {
        setVisibleDomain(pendingPinchDomainRef.current);
      }

      setIsPinching(false);
      pinchStartDistanceRef.current = null;
      pinchStartDomainRef.current = null;
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
    }
  }

  function getTouchPoints() {
    return Array.from(touchPointsRef.current.values()).slice(0, 2);
  }

  function getTouchDistance() {
    const [first, second] = getTouchPoints();

    if (!first || !second) {
      return null;
    }

    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function getTouchCenterX() {
    const [first, second] = getTouchPoints();

    if (!first || !second) {
      return 0;
    }

    return (first.x + second.x) / 2;
  }

  const windowTopM = 2500 + windowOffsetM;
  const windowBottomM = 1500 + windowOffsetM;

  return (
    <section className="card">
      <div className="interactive-chart-heading">
        <div>
          <h2>Interactive Flight Graph</h2>

          <p className="subtitle">
            Pinch to zoom, or drag across the graph on desktop to zoom into a range.
          </p>

          <p className="chart-rotate-hint">
            Rotate your phone for a larger interactive graph.
          </p>
        </div>

        {(showCompetitionContext || showScoreModeControl) && (
          <div
            className={
              "chart-control-row" +
              (showCompetitionContext ? "" : " chart-control-row-score-only")
            }
          >
            {showCompetitionContext && (
              <button
                type="button"
                className={
                  "graph-view-button graph-view-button-left " +
                  (graphView === "comp" ? "active" : "")
                }
                onClick={() => onGraphViewChange("comp")}
                aria-pressed={graphView === "comp"}
              >
                Comp run
              </button>
            )}

            {showScoreModeControl && (
              <label className="score-mode-switch graph-score-mode-switch">
                <span className={scoreMode === "raw" ? "active" : ""}>Raw</span>

                <input
                  type="checkbox"
                  checked={scoreMode === "corrected"}
                  onChange={(event) =>
                    onScoreModeChange(event.target.checked ? "corrected" : "raw")
                  }
                  disabled={winds.length === 0}
                />

                <span className="score-mode-track">
                  <span className="score-mode-knob" />
                </span>

                <span className={scoreMode === "corrected" ? "active" : ""}>
                  Corrected
                </span>
              </label>
            )}

            {showCompetitionContext && (
              <button
                type="button"
                className={
                  "graph-view-button graph-view-button-right " +
                  (graphView === "full" ? "active" : "")
                }
                onClick={() => onGraphViewChange("full")}
                aria-pressed={graphView === "full"}
              >
                Full Jump
              </button>
            )}
          </div>
        )}

        {isZoomed && (
          <button
            type="button"
            className="chart-reset-button"
            onClick={resetZoom}
          >
            Reset zoom
          </button>
        )}
      </div>

      <div
        className="interactive-chart-wrap"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <ResponsiveContainer width="100%" height={460} minWidth={0}>
          <LineChart
            data={chartData}
            margin={{ top: 20, right: 28, bottom: 20, left: 12 }}
            onMouseDown={handleChartMouseDown}
            onMouseMove={handleChartMouseMove}
            onMouseUp={finishChartSelection}
            onMouseLeave={finishChartSelection}
          >
            <CartesianGrid
              stroke="rgba(148, 163, 184, 0.22)"
              strokeDasharray="4 4"
            />

            <XAxis
              dataKey="timeSeconds"
              type="number"
              domain={activeDomain}
              allowDataOverflow
              tickFormatter={(value) => String(Number(value).toFixed(0)) + "s"}
              stroke="#d1d5db"
            />

            <YAxis
              yAxisId="altitude"
              stroke="#d1d5db"
              tickFormatter={(value) => String(Number(value).toFixed(0)) + " m"}
            />

            <YAxis
              yAxisId="speed"
              orientation="right"
              stroke="#2563eb"
              tickFormatter={(value) => String(Number(value).toFixed(0))}
            />

            <YAxis
              yAxisId="glideRatio"
              hide
              type="number"
              domain={[0, 8]}
              allowDataOverflow
            />

            <YAxis
              yAxisId="diveAngle"
              hide
              domain={[0, "auto"]}
            />

            <Tooltip
              active={isPinching ? false : undefined}
              contentStyle={{
                background: "rgba(2, 6, 23, 0.2)",
                border: "1px solid #22d3ee",
                borderRadius: "12px",
                color: "#ffffff",
              }}
              labelFormatter={(value) =>
                "Time: " + Number(value).toFixed(1) + " sec"
              }
              formatter={(value, name) => {
                const numericValue = Number(value);

                const labels: Record<string, string> = {
                  altitudeM: "Altitude",
                  horizontalSpeedKmh: "Horizontal Speed",
                  verticalSpeedKmh: "Vertical Speed",
                  totalSpeedKmh: "Total Speed",
                  glideRatio: "Glide Ratio",
                  diveAngleDeg: "Dive Angle",
                };

                const units: Record<string, string> = {
                  altitudeM: " m",
                  horizontalSpeedKmh: " km/h",
                  verticalSpeedKmh: " km/h",
                  totalSpeedKmh: " km/h",
                  glideRatio: "",
                  diveAngleDeg: " deg",
                };

                return [
                  String(numericValue.toFixed(1)) + (units[String(name)] ?? ""),
                  labels[String(name)] ?? String(name),
                ];
              }}
            />

            {selectionStart !== null && selectionEnd !== null && (
              <ReferenceArea
                yAxisId="altitude"
                x1={Math.min(selectionStart, selectionEnd)}
                x2={Math.max(selectionStart, selectionEnd)}
                stroke="#22d3ee"
                strokeOpacity={0.8}
                fill="#22d3ee"
                fillOpacity={0.18}
              />
            )}

            {showCompetitionContext && (
              <>
                <ReferenceLine
                  yAxisId="altitude"
                  y={windowTopM}
                  stroke="#22c55e"
                  strokeDasharray="6 4"
                  label={{
                    value: String(windowTopM) + " m",
                    fill: "#22c55e",
                    position: "insideTopRight",
                  }}
                />

                <ReferenceLine
                  yAxisId="altitude"
                  y={windowBottomM}
                  stroke="#ef4444"
                  strokeDasharray="6 4"
                  label={{
                    value: String(windowBottomM) + " m",
                    fill: "#ef4444",
                    position: "insideBottomRight",
                  }}
                />
              </>
            )}

<Line
  yAxisId="altitude"
  type="monotone"
  dataKey="altitudeM"
  name="Elevation"
  stroke="#d1d5db"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="horizontalSpeedKmh"
  name="Horizontal Speed"
  stroke="#ef4444"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="verticalSpeedKmh"
  name="Vertical Speed"
  stroke="#22c55e"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="totalSpeedKmh"
  name="Total Speed"
  stroke="#2563eb"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="calculatedAirspeedKmh"
  name="Calculated Airspeed"
  stroke="#f97316"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="glideRatio"
  type="monotone"
  dataKey="glideRatio"
  name="Glide Ratio"
  stroke="#0d9488"
  strokeWidth={2.5}
  dot={false}
  connectNulls
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="diveAngle"
  type="monotone"
  dataKey="diveAngleDeg"
  name="Dive Angle"
  stroke="#f0f"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              );
            }

function NonCompetitionTrackReview({
  points,
  dzElevationM,
  reason,
  startsAtDetectedExit = false,
  winds,
  scoreMode,
  onScoreModeChange,
}: {
  points: GpsTrackPoint[];
  dzElevationM: number;
  reason: string;
  startsAtDetectedExit?: boolean;
  winds: WindLayer[];
  scoreMode: "raw" | "corrected";
  onScoreModeChange: (mode: "raw" | "corrected") => void;
}) {
  const displayedPoints = points.map((point) => ({
    ...point,
    altitudeM: point.altitudeM - dzElevationM,
  }));
  const timestampedPoints = points.filter(
    (point) => point.timestampMs !== null,
  );
  const firstTimestampMs = timestampedPoints[0]?.timestampMs ?? null;
  const lastTimestampMs = timestampedPoints.at(-1)?.timestampMs ?? null;
  const timestampDurationSeconds =
    firstTimestampMs !== null && lastTimestampMs !== null
      ? Math.max(0, (lastTimestampMs - firstTimestampMs) / 1000)
      : null;
  const durationSeconds =
    timestampDurationSeconds !== null && timestampDurationSeconds > 0
      ? timestampDurationSeconds
      : Math.max(0, points.length - 1) * GPS_SAMPLE_PERIOD_SECONDS;
  const maximumAltitudeAglM =
    displayedPoints.length > 0
      ? Math.max(...displayedPoints.map((point) => point.altitudeM))
      : null;

  return (
    <>
      <section className="card track-summary-card">
        <h2>Track Summary</h2>
        <p className="subtitle">
          {reason}{" "}
          {startsAtDetectedExit
            ? "The graph starts at the detected exit and this jump can be saved as Non-comp."
            : "The available track is shown below and can be saved as Non-comp."}
        </p>

        <div className="main-score-columns">
          <div className="main-score-column">
            <div>
              <span>Track duration: </span>
              <strong>{formatNumber(durationSeconds, 1)} sec</strong>
            </div>
            <div>
              <span>Track distance: </span>
              <strong>{formatNumber(getTrackDistanceM(points), 0)} m</strong>
            </div>
          </div>
          <div className="main-score-column">
            <div>
              <span>Maximum altitude: </span>
              <strong>{formatNumber(maximumAltitudeAglM, 0)} m</strong>
            </div>
            <div>
              <span>GPS samples: </span>
              <strong>{points.length}</strong>
            </div>
          </div>
        </div>
      </section>

      <div className="graph-view-container">
        <InteractiveTrackChart
          points={displayedPoints}
          windowOffsetM={0}
          winds={winds}
          graphView="full"
          onGraphViewChange={() => undefined}
          scoreMode={scoreMode}
          onScoreModeChange={onScoreModeChange}
          showCompetitionContext={false}
          showScoreModeControl
        />
      </div>
    </>
  );
}

function TrackComparisonChart({
  tracks,
  windowOffsetM,
}: {
  tracks: CompareTrackOption[];
  windowOffsetM: number;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [visibleXDomain, setVisibleXDomain] = useState<[number, number] | null>(
    null
  );
  const [selectionStartX, setSelectionStartX] = useState<number | null>(null);
  const [selectionEndX, setSelectionEndX] = useState<number | null>(null);
  const [isDraggingDot, setIsDraggingDot] = useState(false);

  const preparedTracks = useMemo(
    () =>
      tracks
        .slice(0, 6)
        .map((track, trackIndex) => {
          try {
            const parsedPoints = trimTrackForAnalysis(
              parseFlySightCsv(track.rawCsv)
            );
            const validatedJump = getValidatedJumpTrack(
              parsedPoints,
              track.dzElevationM
            );

            if (!validatedJump.isValidJump) {
              return null;
            }

            const jumpTrackPoints = validatedJump.jumpPoints.map((point) => ({
              ...point,
              altitudeM: point.altitudeM - track.dzElevationM,
            }));

            const scoringWindowResult = getScoringWindowResult(
              jumpTrackPoints,
              windowOffsetM
            );

            if (!scoringWindowResult) {
              return null;
            }

            const distanceFromEntryByIndex = jumpTrackPoints.map(() => 0);

            for (
              let index = scoringWindowResult.startIndex + 1;
              index < jumpTrackPoints.length;
              index += 1
            ) {
              distanceFromEntryByIndex[index] =
                distanceFromEntryByIndex[index - 1] +
                getTrackDistanceM([
                  jumpTrackPoints[index - 1],
                  jumpTrackPoints[index],
                ]);
            }

            for (
              let index = scoringWindowResult.startIndex - 1;
              index >= 0;
              index -= 1
            ) {
              distanceFromEntryByIndex[index] =
                distanceFromEntryByIndex[index + 1] -
                getTrackDistanceM([
                  jumpTrackPoints[index],
                  jumpTrackPoints[index + 1],
                ]);
            }

            const firstIndex = Math.max(
              0,
              scoringWindowResult.startIndex -
                Math.round(comparePreWindowSeconds / GPS_SAMPLE_PERIOD_SECONDS)
            );
            const lastIndex = Math.min(
              jumpTrackPoints.length - 1,
              scoringWindowResult.endIndex +
                Math.round(comparePostWindowSeconds / GPS_SAMPLE_PERIOD_SECONDS)
            );

            return {
              id: track.id,
              label: track.label,
              color: compareTrackColors[trackIndex],
              dataKey: "track" + trackIndex,
              taskType: track.taskType,
              windowDurationSeconds: scoringWindowResult.timeSeconds,
              windowDistanceM: scoringWindowResult.distanceM,
              windowSpeedKmh:
                scoringWindowResult.timeSeconds > 0
                  ? metresPerSecondToKmh(
                      scoringWindowResult.distanceM /
                        scoringWindowResult.timeSeconds
                    )
                  : null,
              points: jumpTrackPoints
                .slice(firstIndex, lastIndex + 1)
                .map((point, pointOffset) => {
                  const originalIndex = firstIndex + pointOffset;
                  return {
                    relativeTimeSeconds: Number(
                      (
                        (originalIndex - scoringWindowResult.startIndex) *
                        GPS_SAMPLE_PERIOD_SECONDS
                      ).toFixed(1)
                    ),
                    altitudeM: point.altitudeM,
                    distanceFromEntryM: distanceFromEntryByIndex[originalIndex],
                  };
                }),
            };
          } catch (_error) {
            return null;
          }
        })
        .filter((track): track is NonNullable<typeof track> => track !== null),
    [tracks, windowOffsetM]
  );

  const comparisonPoints = preparedTracks.flatMap((track) => track.points);
  const taskTypes = Array.from(
    new Set(
      preparedTracks
        .map((track) => track.taskType)
        .filter(
          (taskType): taskType is TaskMode =>
            taskType === "speed" ||
            taskType === "time" ||
            taskType === "distance",
        )
    )
  );
  const comparisonTask: TaskMode | "mixed" =
    taskTypes.length === 1 ? taskTypes[0] : "mixed";
  const useTimeAxis = comparisonTask === "time";
  const minTime =
    comparisonPoints.length > 0
      ? Math.min(...comparisonPoints.map((point) => point.relativeTimeSeconds))
      : -comparePreWindowSeconds;
  const maxTime =
    comparisonPoints.length > 0
      ? Math.max(...comparisonPoints.map((point) => point.relativeTimeSeconds))
      : comparePostWindowSeconds;
  const minDistance =
    comparisonPoints.length > 0
      ? Math.floor(
          Math.min(...comparisonPoints.map((point) => point.distanceFromEntryM)) /
            100
        ) * 100
      : -200;
  const maxDistance =
    comparisonPoints.length > 0
      ? Math.ceil(
          Math.max(...comparisonPoints.map((point) => point.distanceFromEntryM)) /
            100
        ) * 100
      : 2500;
  const windowTopM = 2500 + windowOffsetM;
  const windowBottomM = 1500 + windowOffsetM;
  const altitudeTicks = Array.from(
    { length: Math.floor((windowTopM - windowBottomM) / 250) + 1 },
    (_, index) => windowBottomM + index * 250
  );
  const xAxisKey = useTimeAxis ? "relativeTimeSeconds" : "distanceFromEntryM";
  const fullXAxisDomain: [number, number] = useTimeAxis
    ? [minTime, maxTime]
    : [minDistance, maxDistance];
  const activeXAxisDomain = visibleXDomain ?? fullXAxisDomain;
  const xAxisUnit = useTimeAxis ? "s" : "m";
  const chartSubtitle =
    comparisonTask === "time"
      ? "Time tracks are compared by seconds spent falling through the window."
      : comparisonTask === "speed"
        ? "Speed tracks are compared by distance covered as the dots move by elapsed time."
        : comparisonTask === "distance"
          ? "Distance tracks are compared by metres flown through the window."
          : "Mixed tasks are shown by distance from window entry.";

  type CompareChartMouseState = {
    activeLabel?: string | number;
  };

  function getActiveXValue(state: CompareChartMouseState | undefined) {
    const value = Number(state?.activeLabel);
    return Number.isFinite(value) ? value : null;
  }

  function clampXDomain(start: number, end: number): [number, number] {
    const minX = Math.min(...fullXAxisDomain);
    const maxX = Math.max(...fullXAxisDomain);
    const nextStart = Math.max(minX, Math.min(start, maxX));
    const nextEnd = Math.max(minX, Math.min(end, maxX));

    return [
      Math.min(nextStart, nextEnd),
      Math.max(nextStart, nextEnd),
    ];
  }

  function getTimeForXValue(
    track: (typeof preparedTracks)[number],
    xValue: number
  ) {
    const firstPoint = track.points[0];
    const lastPoint = track.points.at(-1);

    if (!firstPoint || !lastPoint) {
      return null;
    }

    if (useTimeAxis) {
      return xValue;
    }

    const firstX = firstPoint.distanceFromEntryM;
    const lastX = lastPoint.distanceFromEntryM;

    if (xValue <= firstX) {
      return firstPoint.relativeTimeSeconds;
    }

    if (xValue >= lastX) {
      return lastPoint.relativeTimeSeconds;
    }

    const nextIndex = track.points.findIndex(
      (point) => point.distanceFromEntryM >= xValue
    );

    if (nextIndex <= 0) {
      return firstPoint.relativeTimeSeconds;
    }

    const previousPoint = track.points[nextIndex - 1];
    const nextPoint = track.points[nextIndex];
    const span =
      nextPoint.distanceFromEntryM - previousPoint.distanceFromEntryM;
    const progress =
      span > 0 ? (xValue - previousPoint.distanceFromEntryM) / span : 0;

    return (
      previousPoint.relativeTimeSeconds +
      (nextPoint.relativeTimeSeconds - previousPoint.relativeTimeSeconds) *
        progress
    );
  }

  function getPlaybackTimeRange() {
    if (!visibleXDomain) {
      return [minTime, maxTime] as [number, number];
    }

    const times = preparedTracks.flatMap((track) =>
      visibleXDomain
        .map((xValue) => getTimeForXValue(track, xValue))
        .filter((value): value is number => value !== null)
    );

    if (times.length === 0) {
      return [minTime, maxTime] as [number, number];
    }

    return [Math.min(...times), Math.max(...times)] as [number, number];
  }

  function scrubToXValue(xValue: number) {
    const times = preparedTracks
      .map((track) => getTimeForXValue(track, xValue))
      .filter((value): value is number => value !== null);

    if (times.length === 0) {
      return;
    }

    setPlayheadSeconds(times.reduce((total, time) => total + time, 0) / times.length);
  }

  function handleCompareMouseDown(state: CompareChartMouseState | undefined) {
    const value = getActiveXValue(state);

    if (value === null) {
      return;
    }

    if (isDraggingDot) {
      scrubToXValue(value);
      return;
    }

    setSelectionStartX(value);
    setSelectionEndX(value);
  }

  function handleCompareMouseMove(state: CompareChartMouseState | undefined) {
    const value = getActiveXValue(state);

    if (value === null) {
      return;
    }

    if (isDraggingDot) {
      scrubToXValue(value);
      return;
    }

    if (selectionStartX !== null) {
      setSelectionEndX(value);
    }
  }

  function finishCompareSelection() {
    if (isDraggingDot) {
      setIsDraggingDot(false);
      return;
    }

    if (selectionStartX === null || selectionEndX === null) {
      setSelectionStartX(null);
      setSelectionEndX(null);
      return;
    }

    const selectionSize = Math.abs(selectionEndX - selectionStartX);
    const minimumSelectionSize =
      Math.abs(fullXAxisDomain[1] - fullXAxisDomain[0]) * 0.04;

    if (selectionSize >= minimumSelectionSize) {
      const nextDomain = clampXDomain(selectionStartX, selectionEndX);
      setVisibleXDomain(nextDomain);
      scrubToXValue(nextDomain[0]);
    }

    setSelectionStartX(null);
    setSelectionEndX(null);
  }

  function getCompareReadout(
    track: (typeof preparedTracks)[number],
    dot: { distanceFromEntryM: number; track: { id: string } } | undefined
  ) {
    if (comparisonTask === "time") {
      return `${formatNumber(track.windowDurationSeconds, 2)} sec`;
    }

    if (comparisonTask === "speed") {
      return `${formatNumber(track.windowSpeedKmh, 1)} km/h`;
    }

    const distanceM =
      comparisonTask === "distance"
        ? track.windowDistanceM
        : dot?.distanceFromEntryM ?? null;

    return `${formatNumber(distanceM, 0)} m`;
  }

  function getTrackPositionAtTime(
    track: (typeof preparedTracks)[number],
    timeSeconds: number
  ) {
    const firstPoint = track.points[0];
    const lastPoint = track.points.at(-1);

    if (!firstPoint || !lastPoint) {
      return null;
    }

    if (timeSeconds <= firstPoint.relativeTimeSeconds) {
      return firstPoint;
    }

    if (timeSeconds >= lastPoint.relativeTimeSeconds) {
      return lastPoint;
    }

    const nextIndex = track.points.findIndex(
      (point) => point.relativeTimeSeconds >= timeSeconds
    );

    if (nextIndex <= 0) {
      return firstPoint;
    }

    const previousPoint = track.points[nextIndex - 1];
    const nextPoint = track.points[nextIndex];
    const span =
      nextPoint.relativeTimeSeconds - previousPoint.relativeTimeSeconds;
    const progress =
      span > 0
        ? (timeSeconds - previousPoint.relativeTimeSeconds) / span
        : 0;

    return {
      relativeTimeSeconds: timeSeconds,
      altitudeM:
        previousPoint.altitudeM +
        (nextPoint.altitudeM - previousPoint.altitudeM) * progress,
      distanceFromEntryM:
        previousPoint.distanceFromEntryM +
        (nextPoint.distanceFromEntryM - previousPoint.distanceFromEntryM) *
          progress,
    };
  }

  function getTrackTraceAtTime(
    track: (typeof preparedTracks)[number],
    timeSeconds: number
  ) {
    const currentPoint = getTrackPositionAtTime(track, timeSeconds);

    if (!currentPoint) {
      return [];
    }

    if (timeSeconds <= track.points[0].relativeTimeSeconds) {
      return [currentPoint];
    }

    const completedPoints = track.points.filter(
      (point) => point.relativeTimeSeconds < timeSeconds
    );

    return [...completedPoints, currentPoint];
  }

  const animatedTrackTraces = preparedTracks.map((track) => ({
    track,
    points: getTrackTraceAtTime(track, playheadSeconds),
  }));

  const animatedDots = preparedTracks
    .map((track) => {
      const point = getTrackPositionAtTime(track, playheadSeconds);
      return point ? { ...point, track } : null;
    })
    .filter((dot): dot is NonNullable<typeof dot> => dot !== null);

  useEffect(() => {
    setPlayheadSeconds(minTime);
    setIsPlaying(false);
    setVisibleXDomain(null);
    setSelectionStartX(null);
    setSelectionEndX(null);
    setIsDraggingDot(false);
  }, [minTime, maxTime, tracks.length, xAxisKey]);

  useEffect(() => {
    if (!isPlaying || preparedTracks.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setPlayheadSeconds((current) => {
        const [playStartTime, playEndTime] = getPlaybackTimeRange();
        const next = current + 0.25;
        return next >= playEndTime ? playStartTime : next;
      });
    }, 50);

    return () => window.clearInterval(timer);
  }, [isPlaying, maxTime, minTime, preparedTracks, visibleXDomain]);

  if (tracks.length === 0) {
    return null;
  }

  return (
    <section className="card compare-chart-card">
      <div className="compare-chart-heading">
        <h2>Track Comparison</h2>
        <p className="subtitle">
          {chartSubtitle}
        </p>

        <div className="compare-control-row">
          <span />
          <button
            type="button"
            className="compare-play-button"
            onClick={() => setIsPlaying((current) => !current)}
            disabled={preparedTracks.length === 0}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>

          {visibleXDomain ? (
            <button
              type="button"
              className="compare-play-button"
              onClick={() => {
                setVisibleXDomain(null);
                setSelectionStartX(null);
                setSelectionEndX(null);
              }}
            >
              Reset zoom
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>

      {preparedTracks.length === 0 ? (
        <p className="subtitle">
          Selected tracks need a detected scoring window before they can be compared.
        </p>
      ) : (
        <>
          <div className="compare-chart-legend">
            {preparedTracks.map((track) => (
              <span key={track.id}>
                <span
                  className="compare-color-swatch"
                  style={{ background: track.color }}
                />
                {track.label}
                <strong className="compare-distance-readout">
                  {getCompareReadout(
                    track,
                    animatedDots.find((dot) => dot.track.id === track.id)
                  )}
                </strong>
              </span>
            ))}
          </div>

          <div className="compare-chart-wrap">
            <ResponsiveContainer width="100%" height={460} minWidth={0}>
              <LineChart
                margin={{ top: 18, right: 26, bottom: 18, left: 10 }}
                onMouseDown={handleCompareMouseDown}
                onMouseMove={handleCompareMouseMove}
                onMouseUp={finishCompareSelection}
                onMouseLeave={finishCompareSelection}
              >
                <CartesianGrid
                  stroke="rgba(148, 163, 184, 0.22)"
                  strokeDasharray="4 4"
                />
                <XAxis
                  dataKey={xAxisKey}
                  type="number"
                  domain={activeXAxisDomain}
                  allowDataOverflow
                  tickFormatter={(value) =>
                    String(Number(value).toFixed(useTimeAxis ? 0 : 0)) +
                    " " +
                    xAxisUnit
                  }
                  stroke="#d1d5db"
                />
                <YAxis
                  dataKey="altitudeM"
                  type="number"
                  domain={[windowBottomM, windowTopM]}
                  ticks={altitudeTicks}
                  tickFormatter={(value) => String(Number(value).toFixed(0)) + " m"}
                  stroke="#d1d5db"
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(2, 6, 23, 0.9)",
                    border: "1px solid #22d3ee",
                    borderRadius: "8px",
                    color: "#ffffff",
                  }}
                  labelFormatter={(value) =>
                    (useTimeAxis ? "Time from entry: " : "Distance from entry: ") +
                    Number(value).toFixed(useTimeAxis ? 1 : 0) +
                    " " +
                    xAxisUnit
                  }
                  formatter={(value, name) => [
                    String(Number(value).toFixed(0)) + " m altitude",
                    preparedTracks.find((track) => track.dataKey === name)?.label ??
                      String(name),
                  ]}
                />
                {selectionStartX !== null && selectionEndX !== null && (
                  <ReferenceArea
                    x1={Math.min(selectionStartX, selectionEndX)}
                    x2={Math.max(selectionStartX, selectionEndX)}
                    stroke="#22d3ee"
                    strokeOpacity={0.85}
                    fill="#22d3ee"
                    fillOpacity={0.16}
                  />
                )}
                <ReferenceLine
                  y={windowTopM}
                  stroke="#22c55e"
                  strokeDasharray="6 4"
                  label={{
                    value: "Window start",
                    fill: "#22c55e",
                    position: "insideTopRight",
                  }}
                />
                <ReferenceLine
                  y={windowBottomM}
                  stroke="#ef4444"
                  strokeDasharray="6 4"
                  label={{
                    value: "Window end",
                    fill: "#ef4444",
                    position: "insideBottomRight",
                  }}
                />
                {animatedTrackTraces.map(({ track, points }) => (
                  <Line
                    key={track.id}
                    type="monotone"
                    data={points}
                    dataKey="altitudeM"
                    name={track.label}
                    stroke={track.color}
                    strokeWidth={2.8}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    activeDot={{ r: 5 }}
                  />
                ))}
                {animatedDots.map((dot) => (
                  <ReferenceDot
                    key={dot.track.id}
                    x={
                      useTimeAxis
                        ? dot.relativeTimeSeconds
                        : dot.distanceFromEntryM
                    }
                    y={dot.altitudeM}
                    r={7}
                    fill={dot.track.color}
                    stroke={dot.track.color === "#ffffff" ? "#020617" : "#ffffff"}
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    onMouseDown={() => {
                      setIsPlaying(false);
                      setIsDraggingDot(true);
                    }}
                    onTouchStart={() => {
                      setIsPlaying(false);
                      setIsDraggingDot(true);
                    }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
}

type AuthModalProps = {
  session: Session | null;
  email: string;
  status: string;
  busy: boolean;
  onEmailChange: (email: string) => void;
  onGoogleSignIn: (credential: string, nonce: string) => void;
  onGoogleSignInError: (message: string) => void;
  onEmailLinkSignIn: () => void;
  onSignOut: () => void;
  onClose: () => void;
};

function GoogleSignInButton({
  busy,
  onCredential,
  onError,
}: {
  busy: boolean;
  onCredential: (credential: string, nonce: string) => void;
  onError: (message: string) => void;
}) {
  const buttonContainerRef = useRef<HTMLDivElement>(null);
  const credentialHandlerRef = useRef(onCredential);
  const errorHandlerRef = useRef(onError);

  useEffect(() => {
    credentialHandlerRef.current = onCredential;
    errorHandlerRef.current = onError;
  }, [onCredential, onError]);

  useEffect(() => {
    let active = true;

    void Promise.all([
      loadGoogleIdentityServices(),
      createGoogleSignInNonce(),
    ])
      .then(([google, { nonce, hashedNonce }]) => {
        const container = buttonContainerRef.current;
        if (!active || !container) {
          return;
        }

        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            if (response.credential) {
              credentialHandlerRef.current(response.credential, nonce);
            } else {
              errorHandlerRef.current(
                "Google did not return a sign-in credential. Please try again.",
              );
            }
          },
          nonce: hashedNonce,
          use_fedcm_for_prompt: true,
        });

        container.replaceChildren();
        google.accounts.id.renderButton(container, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "continue_with",
          logo_alignment: "left",
          width: Math.max(200, Math.min(400, container.clientWidth)),
        });
      })
      .catch((error: unknown) => {
        if (active) {
          errorHandlerRef.current(
            error instanceof Error
              ? error.message
              : "Google sign-in could not be loaded.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div
      className={`google-sign-in-container${busy ? " is-busy" : ""}`}
      aria-busy={busy}
      ref={buttonContainerRef}
    />
  );
}

function AuthModal({
  session,
  email,
  status,
  busy,
  onEmailChange,
  onGoogleSignIn,
  onGoogleSignInError,
  onEmailLinkSignIn,
  onSignOut,
  onClose,
}: AuthModalProps) {
  return (
    <div
      className="auth-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      onClick={onClose}
    >
      <section
        className="auth-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="auth-modal-close"
          onClick={onClose}
          aria-label="Close sign-in window"
        >
          ×
        </button>

        <h2 id="auth-modal-title">
          {session ? "Your logbook account" : "Sign in to your logbook"}
        </h2>

        {session ? (
          <>
            <p className="subtitle">
              Signed in as <strong>{session.user.email}</strong>
            </p>

            <div className="auth-modal-actions">
              <button type="button" onClick={onSignOut} disabled={busy}>
                {busy ? "Please wait..." : "Sign out"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="auth-modal-intro">
              Use Google for the quickest sign-in, or receive a secure sign-in
              link by email. No password is required.
            </p>

            <GoogleSignInButton
              busy={busy}
              onCredential={onGoogleSignIn}
              onError={onGoogleSignInError}
            />

            <div className="auth-divider" aria-hidden="true">
              <span>or</span>
            </div>

            <label>
              Email address
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@example.com"
                onChange={(event) => onEmailChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && email.trim() && !busy) {
                    onEmailLinkSignIn();
                  }
                }}
              />
            </label>

            <button
              type="button"
              className="email-link-sign-in-button"
              onClick={onEmailLinkSignIn}
              disabled={busy || !email.trim()}
            >
              {busy ? "Please wait..." : "Email me a sign-in link"}
            </button>

            <p className="auth-session-note">
              You will stay signed in on this device until you sign out.
            </p>
          </>
        )}

        {status && (
          <p className="auth-status" aria-live="polite">
            {status}
          </p>
        )}
      </section>
    </div>
  );
}

function App() {
  const [supabaseSession, setSupabaseSession] = useState<Session | null>(null);
  const [trackAssessorAccess, setTrackAssessorAccess] =
    useState<TrackAssessorAccessState>("checking");
  const [assessorTaskMode, setAssessorTaskMode] =
    useState<TaskMode>("distance");
  const [assessorTailwindKts, setAssessorTailwindKts] = useState("");
  const loadedFindDetailsUserIdRef = useRef<string | null>(null);
  const [findUnitSystem, setFindUnitSystem] = useState<UnitSystem>("metric");
  const [findWeight, setFindWeight] = useState("");
  const [findHeightCm, setFindHeightCm] = useState("");
  const [findHeightFeet, setFindHeightFeet] = useState("");
  const [findHeightInches, setFindHeightInches] = useState("");
  const [findSuitSetup, setFindSuitSetup] = useState<SuitSetup>("");
  const [findNumbersOverride, setFindNumbersOverride] =
    useState<SavedFindNumbers | null>(null);
  const [findDetailsStatus, setFindDetailsStatus] = useState("");
  const [findDetailsBusy, setFindDetailsBusy] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [graphView, setGraphView] = useState<"comp" | "full">("comp");
    const [jumpScoreMode, setJumpScoreMode] = useState<"raw" | "corrected">("raw");
  const [showLogbookLogin, setShowLogbookLogin] = useState(false);
  const [saveJumpStatus, setSaveJumpStatus] = useState("");
  const [saveJumpBusy, setSaveJumpBusy] = useState(false);
  const [trackInfoEditJumpId, setTrackInfoEditJumpId] = useState<string | null>(null);
  const [jumpLocationName, setJumpLocationName] = useState("");
  const [jumpSuitName, setJumpSuitName] = useState("");
  const [jumpNotes, setJumpNotes] = useState("");
  type SavedJump = {
  raw_csv: string | null;
  exit_latitude: number | null;
  exit_longitude: number | null;
  landing_latitude: number | null;
  landing_longitude: number | null;
  dz_elevation_m: number | null;  id: string;
  jump_date: string | null;
  task_type: LogbookTrackType | null;
  location_name: string | null;
  suit_name: string | null;
  notes: string | null;
  window_time_s: number | null;
  window_distance_m: number | null;
  window_speed_kmh: number | null;
};

const [savedJumps, setSavedJumps] = useState<SavedJump[]>([]);
const [logbookTaskFilter, setLogbookTaskFilter] =
  useState<"recent" | "all" | LogbookTrackType>("recent");
const [logbookSearchQuery, setLogbookSearchQuery] = useState("");
const [logbookStatus, setLogbookStatus] = useState("");
const [editingJumpId, setEditingJumpId] = useState<string | null>(null);
const [logbookActionMenu, setLogbookActionMenu] = useState<{
  jumpId: string;
  left: number;
  top: number;
} | null>(null);
const [editLocationName, setEditLocationName] = useState("");
const [editSuitName, setEditSuitName] = useState("");
const [editNotes, setEditNotes] = useState("");

const loadFindDetailsFromSession = useCallback((session: Session | null) => {
  const userId = session?.user.id ?? null;

  if (!userId) {
    loadedFindDetailsUserIdRef.current = null;
    return;
  }

  if (loadedFindDetailsUserIdRef.current === userId) {
    return;
  }

  loadedFindDetailsUserIdRef.current = userId;
  const savedDetails = getSavedFindDetails(session);

  if (!savedDetails) {
    return;
  }

  setFindUnitSystem(savedDetails.unitSystem);
  setFindWeight(savedDetails.weight);
  setFindHeightCm(savedDetails.heightCm);
  setFindHeightFeet(savedDetails.heightFeet);
  setFindHeightInches(savedDetails.heightInches);
  setFindSuitSetup(savedDetails.suitSetup);
  setFindNumbersOverride(savedDetails.numbers ?? null);
  setFindDetailsStatus("Your saved details have been loaded.");

  const calculatedNumbers = calculateFindYourNumbers(savedDetails);
  const savedNumbers = savedDetails.numbers ?? {
    distanceSpeedKph: String(calculatedNumbers.distanceSpeedKph),
    timeSpeedKph: String(calculatedNumbers.timeSpeedKph),
    speedStartGR: calculatedNumbers.speedStartGR.toFixed(2),
    speedEndGR: calculatedNumbers.speedEndGR.toFixed(2),
  };
  const distanceSpeed = savedNumbers.distanceSpeedKph;

  setSavedDistanceSpeedKph(distanceSpeed);
  setSavedTimeSpeedKph(savedNumbers.timeSpeedKph);
  setZeroWindSpeedKph(distanceSpeed);
  setStartGR(savedNumbers.speedStartGR);
  setEndGR(savedNumbers.speedEndGR);
}, []);

function getLogbookScoreForTask(jump: SavedJump, task: TaskMode): number | null {
  if (task === "speed") return jump.window_speed_kmh;
  if (task === "time") return jump.window_time_s;
  return jump.window_distance_m;
}

type LogbookComparisonFilter = {
  metric: TaskMode | "any";
  value: number;
};

function getLogbookComparisonFilters(query: string) {
  const filters: LogbookComparisonFilter[] = [];
  const comparisonPattern =
    /\b(?:better than|greater than|higher than|over|more than|more|further than|further)\s+(\d+(?:\.\d+)?)\s*(kilometers per hour|kilometres per hour|km\/h|kph|kmh|seconds?|secs?|kilometers?|kilometres?|meters?|metres?|kms?|km|m|s)?\b/gi;
  const bareNumberPattern =
    /\b(\d+(?:\.\d+)?)\s*(kilometers per hour|kilometres per hour|km\/h|kph|kmh|seconds?|secs?|kilometers?|kilometres?|meters?|metres?|kms?|km|m|s)?\b/gi;

  function addComparisonFilter(rawValue: string, rawUnit: string | undefined) {
    const value = Number(rawValue);
    const unit = (rawUnit ?? "").toLowerCase();

    if (!Number.isFinite(value)) {
      return false;
    }

    if (!unit) {
      filters.push({ metric: "any", value });
      return true;
    }

    if (
      unit.includes("kph") ||
      unit.includes("km/h") ||
      unit.includes("kmh") ||
      unit.includes("per hour")
    ) {
      filters.push({ metric: "speed", value });
      return true;
    }

    if (unit.startsWith("sec") || unit === "s") {
      filters.push({ metric: "time", value });
      return true;
    }

    if (
      unit.startsWith("km") ||
      unit.startsWith("kilometer") ||
      unit.startsWith("kilometre")
    ) {
      filters.push({ metric: "distance", value: value * 1000 });
      return true;
    }

    if (
      unit === "m" ||
      unit.startsWith("meter") ||
      unit.startsWith("metre")
    ) {
      filters.push({ metric: "distance", value });
      return true;
    }

    return false;
  }

  const queryWithoutComparisonPhrases = query.replace(
    comparisonPattern,
    (match, rawValue: string, rawUnit: string | undefined) => {
      return addComparisonFilter(rawValue, rawUnit) ? " " : match;
    }
  );
  const remainingQuery = queryWithoutComparisonPhrases.replace(
    bareNumberPattern,
    (match, rawValue: string, rawUnit: string | undefined) =>
      addComparisonFilter(rawValue, rawUnit) ? " " : match
  );

  return { filters, remainingQuery };
}

function getPinnedBestJumpIds(jumps: SavedJump[]): Set<string> {
  const tasks: TaskMode[] =
    logbookTaskFilter === "speed" ||
    logbookTaskFilter === "time" ||
    logbookTaskFilter === "distance"
      ? [logbookTaskFilter]
      : ["speed", "time", "distance"];

  return new Set(
    tasks.flatMap((task) => {
      const bestJump = jumps.reduce<SavedJump | null>((best, jump) => {
        if (jump.task_type !== task) return best;

        const score = getLogbookScoreForTask(jump, task);
        if (score === null || !Number.isFinite(score)) return best;

        const bestScore = best === null ? null : getLogbookScoreForTask(best, task);
        return bestScore === null || score > bestScore ? jump : best;
      }, null);

      return bestJump ? [bestJump.id] : [];
    })
  );
}

function pinBestLogbookJumps(jumps: SavedJump[]): SavedJump[] {
  const pinnedIds = getPinnedBestJumpIds(jumps);

  if (pinnedIds.size === 0) {
    return jumps;
  }

  return [
    ...jumps.filter((jump) => pinnedIds.has(jump.id)),
    ...jumps.filter((jump) => !pinnedIds.has(jump.id)),
  ];
}

  useEffect(() => {
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error("Supabase session error:", error.message);
        return;
      }

      setSupabaseSession(data.session);
      loadFindDetailsFromSession(data.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSupabaseSession(session);
      loadFindDetailsFromSession(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [loadFindDetailsFromSession]);

  useEffect(() => {
    let active = true;
    const signedInEmail = supabaseSession?.user.email?.trim().toLowerCase();

    if (!signedInEmail) {
      setTrackAssessorAccess("checking");
      return () => {
        active = false;
      };
    }

    const isDevelopmentPreviewAccount =
      import.meta.env.DEV &&
      (signedInEmail === "flywithcruza@gmail.com" ||
        signedInEmail === "starcruza@hotmail.com");

    if (isDevelopmentPreviewAccount) {
      setTrackAssessorAccess("allowed");
      return () => {
        active = false;
      };
    }

    setTrackAssessorAccess("checking");

    void supabase
      .from("app_access")
      .select("can_use_track_assessor")
      .eq("email", signedInEmail)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) {
          return;
        }

        if (error) {
          console.error("Track Assessor access check failed:", error.message);
          setTrackAssessorAccess("denied");
          return;
        }

        setTrackAssessorAccess(
          data?.can_use_track_assessor === true ? "allowed" : "denied",
        );
      });

    return () => {
      active = false;
    };
  }, [supabaseSession?.user.id, supabaseSession?.user.email]);

      useEffect(() => {
    void loadSavedJumps();
  }, [supabaseSession, logbookTaskFilter]);

  useEffect(() => {
    if (!logbookActionMenu) {
      return;
    }

    function closeLogbookActionMenu() {
      setLogbookActionMenu(null);
    }

    window.addEventListener("pointerdown", closeLogbookActionMenu);
    return () => {
      window.removeEventListener("pointerdown", closeLogbookActionMenu);
    };
  }, [logbookActionMenu]);

  function getAuthRedirectUrl() {
    return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
  }

  async function handleGoogleSignIn(credential: string, nonce: string) {
    setAuthBusy(true);
    setAuthStatus("");

    const { error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: credential,
      nonce,
    });

    if (error) {
      setAuthStatus(error.message);
    } else {
      setShowLogbookLogin(false);
    }

    setAuthBusy(false);
  }

  function handleGoogleSignInError(message: string) {
    setAuthStatus(message);
    setAuthBusy(false);
  }

  async function handleEmailLinkSignIn() {
    setAuthBusy(true);
    setAuthStatus("");

    const email = authEmail.trim();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: getAuthRedirectUrl(),
        shouldCreateUser: true,
      },
    });

    if (error) {
      setAuthStatus(error.message);
    } else {
      setAuthStatus(`Check ${email} for your secure sign-in link.`);
    }

    setAuthBusy(false);
  }

  async function handleSignOut() {
    setAuthBusy(true);
    setAuthStatus("");

    const { error } = await supabase.auth.signOut();

    if (error) {
      setAuthStatus(error.message);
    } else {
      setAuthStatus("Signed out.");
    }

    setAuthBusy(false);
  }

    async function handleSaveJump(taskType: LogbookTrackType) {
    const editingSavedJumpId = trackInfoEditJumpId;

    if (!supabaseSession) {
      setSaveJumpStatus("Please sign in before saving a jump.");
      return;
    }

    if (!rawGpsCsv || gpsTrackPoints.length === 0) {
      setSaveJumpStatus("Import a FlySight CSV before saving.");
      return;
    }

    const dzElevationNumber = numberFromInput(dzElevationM, 0);

    const validatedJump = getValidatedJumpTrack(
      gpsTrackPoints,
      dzElevationNumber
    );

    const isNonCompetitionTrack = taskType === "non-comp";
    const detectedJumpTrack = isNonCompetitionTrack
      ? getDetectedJumpTrack(gpsTrackPoints)
      : null;
    const exitPoint =
      validatedJump.exitPoint ?? detectedJumpTrack?.exitPoint ?? null;

    if (!isNonCompetitionTrack && (!validatedJump.isValidJump || !exitPoint)) {
      setSaveJumpStatus("A valid jump exit could not be detected.");
      return;
    }

    const jumpTrackPointsAgl = validatedJump.isValidJump
      ? validatedJump.jumpPoints.map((point) => ({
          ...point,
          altitudeM: point.altitudeM - dzElevationNumber,
        }))
      : [];

    const scoringWindowResult =
      jumpTrackPointsAgl.length > 0
        ? getScoringWindowResult(jumpTrackPointsAgl, windowOffsetM)
        : null;

    if (!isNonCompetitionTrack && !scoringWindowResult) {
      setSaveJumpStatus("A complete scoring window could not be detected.");
      return;
    }

    const windowSpeedKmh =
      scoringWindowResult !== null && scoringWindowResult.timeSeconds > 0
        ? metresPerSecondToKmh(
            scoringWindowResult.distanceM /
              scoringWindowResult.timeSeconds
          )
        : null;

    const trimmedTrackPoints = trimTrackAfterLanding(gpsTrackPoints);
    const landingPoint =
      trimmedTrackPoints[trimmedTrackPoints.length - 1] ??
      gpsTrackPoints[gpsTrackPoints.length - 1];
    const timestampedTrackPoint =
      exitPoint ??
      gpsTrackPoints.find((point) => point.timestampMs !== null) ??
      null;

    setSaveJumpBusy(true);
    setSaveJumpStatus("");

    const jumpPayload = {
      user_id: supabaseSession.user.id,
      task_type: taskType,
      jump_date:
        timestampedTrackPoint?.timestampMs !== null &&
        timestampedTrackPoint?.timestampMs !== undefined
          ? new Date(timestampedTrackPoint.timestampMs).toISOString()
          : null,
      location_name: jumpLocationName.trim() || null,
      suit_name: jumpSuitName.trim() || null,
      notes: jumpNotes.trim() || null,
      exit_latitude: exitPoint?.lat ?? null,
      exit_longitude: exitPoint?.lon ?? null,
      landing_latitude: landingPoint?.lat ?? null,
      landing_longitude: landingPoint?.lon ?? null,
      dz_elevation_m: dzElevationNumber,
      exit_altitude_m:
        exitPoint === null ? null : exitPoint.altitudeM - dzElevationNumber,
      window_time_s: scoringWindowResult?.timeSeconds ?? null,
      window_distance_m: scoringWindowResult?.distanceM ?? null,
      window_speed_kmh: windowSpeedKmh,
      raw_csv: rawGpsCsv,
    };

    let error;

    if (editingSavedJumpId) {
      const updateResult = await supabase
        .from("jumps")
        .update(jumpPayload)
        .eq("id", editingSavedJumpId);
      error = updateResult.error;
    } else {
      const insertResult = await supabase.from("jumps").insert(jumpPayload);
      error = insertResult.error;
    }

    if (
      error &&
      taskType !== "non-comp" &&
      String(error.message).toLowerCase().includes("task_type")
    ) {
      const { task_type: _taskType, ...legacyJumpPayload } = jumpPayload;

      const legacyResult = editingSavedJumpId
        ? await supabase
            .from("jumps")
            .update(legacyJumpPayload)
            .eq("id", editingSavedJumpId)
        : await supabase.from("jumps").insert(legacyJumpPayload);
      error = legacyResult.error;

      if (!error) {
        setSaveJumpStatus(
          editingSavedJumpId
            ? "Jump updated, but task type was not stored. Add the task_type column to enable task filtering."
            : "Jump saved, but task type was not stored. Add the task_type column to enable task filtering."
        );
        setTrackInfoEditJumpId(null);
        void loadSavedJumps();
        setSaveJumpBusy(false);
        return;
      }
    }

    if (error) {
      setSaveJumpStatus(`Could not save jump: ${error.message}`);
    } else {
      setSaveJumpStatus(
        editingSavedJumpId
          ? `Jump updated as ${formatLogbookTrackType(taskType)}.`
          : `Jump saved as ${formatLogbookTrackType(taskType)}.`
      );
      setTrackInfoEditJumpId(null);
      void loadSavedJumps();
    }

    setSaveJumpBusy(false);
  }

    async function loadSavedJumps() {
    if (!supabaseSession) {
      setSavedJumps([]);
      setLogbookStatus("");
      return;
    }

    setLogbookStatus("Loading logbook...");

    const oneWeekAgoIso = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const selectWithTaskType =
      "id, jump_date, task_type, location_name, suit_name, notes, window_time_s, window_distance_m, window_speed_kmh, exit_latitude, exit_longitude, landing_latitude, landing_longitude, dz_elevation_m, raw_csv";

    const selectWithoutTaskType =
      "id, jump_date, location_name, suit_name, notes, window_time_s, window_distance_m, window_speed_kmh, exit_latitude, exit_longitude, landing_latitude, landing_longitude, dz_elevation_m, raw_csv";

    let query = supabase
      .from("jumps")
      .select(selectWithTaskType);

    if (logbookTaskFilter === "recent") {
      query = query.gte("jump_date", oneWeekAgoIso);
    }

    if (
      logbookTaskFilter === "speed" ||
      logbookTaskFilter === "time" ||
      logbookTaskFilter === "distance" ||
      logbookTaskFilter === "non-comp"
    ) {
      query = query.eq("task_type", logbookTaskFilter);
    }

    let { data, error } = await query
      .order("jump_date", { ascending: false });

    if (
      error &&
      String(error.message).toLowerCase().includes("task_type")
    ) {
      if (logbookTaskFilter !== "all" && logbookTaskFilter !== "recent") {
        setSavedJumps([]);
        setLogbookStatus(
          "Task filtering needs the task_type database column. Switch to All or add the column."
        );
        return;
      }

      let legacyQuery = supabase
        .from("jumps")
        .select(selectWithoutTaskType);

      if (logbookTaskFilter === "recent") {
        legacyQuery = legacyQuery.gte("jump_date", oneWeekAgoIso);
      }

      const legacyResult = await legacyQuery.order("jump_date", {
        ascending: false,
      });

      data =
        legacyResult.data?.map((jump) => ({
          ...jump,
          task_type: null,
        })) ?? null;
      error = legacyResult.error;
    }

    if (error) {
      setLogbookStatus(`Could not load logbook: ${error.message}`);
      return;
    }

    const normalizedJumps = ((data ?? []).map((jump) => ({
        ...jump,
        task_type: "task_type" in jump ? jump.task_type : null,
      })) ?? []) as SavedJump[];

    setSavedJumps(pinBestLogbookJumps(normalizedJumps));
    setLogbookStatus(
      data && data.length > 0
        ? ""
        : logbookTaskFilter === "recent"
          ? "No saved jumps found from the last week."
          : logbookTaskFilter === "all"
            ? "No saved jumps yet."
            : `No saved ${logbookTaskFilter} jumps found.`
    );
  }

  function findMatchingSavedLocation(landingPoint: GpsTrackPoint) {
    const matchRadiusM = nmToMetres(3);
    const matches: { locationName: string; distanceM: number }[] = [];

    savedJumps.forEach((jump) => {
      if (
        !jump.location_name ||
        jump.landing_latitude === null ||
        jump.landing_longitude === null
      ) {
        return;
      }

      const lat1Rad = degToRad(landingPoint.lat);
      const lat2Rad = degToRad(jump.landing_latitude);
      const deltaLatRad = degToRad(jump.landing_latitude - landingPoint.lat);
      const deltaLonRad = degToRad(jump.landing_longitude - landingPoint.lon);

      const a =
        Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
        Math.cos(lat1Rad) *
          Math.cos(lat2Rad) *
          Math.sin(deltaLonRad / 2) *
          Math.sin(deltaLonRad / 2);

      const distanceM = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      if (distanceM <= matchRadiusM) {
        matches.push({
          locationName: jump.location_name,
          distanceM,
        });
      }
    });

    return (
      matches.sort((first, second) => first.distanceM - second.distanceM)[0] ??
      null
    );
  }

    async function editSavedJumpInTrackInfo(jump: SavedJump) {
    setTrackInfoEditJumpId(jump.id);
    await openSavedJump(jump, { preserveTrackInfoEdit: true });
    setTrackInfoEditJumpId(jump.id);
    setEditingJumpId(null);
    setSaveJumpStatus(
      "Editing saved jump. Change Track Info, then choose the appropriate save type below."
    );
    window.setTimeout(() => {
      document.querySelector(".save-jump-card")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 150);
  }

    async function openSavedJump(
      jump: SavedJump,
      options: { preserveTrackInfoEdit?: boolean } = {}
    ) {
      if (!jump.raw_csv) {
        setLogbookStatus(
          "This saved jump does not contain the original CSV."
        );
        return;
      }

      const parsedPoints = parseFlySightCsv(jump.raw_csv);
      const workingTrackPoints = trimTrackForAnalysis(parsedPoints);
      const dzElevationNumber = jump.dz_elevation_m ?? 0;

      if (!options.preserveTrackInfoEdit) {
        setTrackInfoEditJumpId(null);
      }
      setRawGpsCsv(jump.raw_csv);
      setGpsTrackPoints(workingTrackPoints);
      setIgnoredGroundSampleCount(
        Math.max(0, parsedPoints.length - workingTrackPoints.length)
      );
      setCompetitionReferenceLat("");
      setCompetitionReferenceLon("");
      setCompetitionReferenceGroupId(null);
      setShowCompetitionReferencePicker(false);
      setHistoricalWinds([]);
      setHistoricalWindStatus("Loading historical winds...");

      setGpsFileName(
        jump.jump_date
          ? `Saved jump ${new Date(jump.jump_date).toLocaleString()}`
          : "Saved jump"
      );

      setJumpLocationName(jump.location_name ?? "");
      setJumpSuitName(jump.suit_name ?? "");
      setJumpNotes(jump.notes ?? "");
      setDzElevationM(String(dzElevationNumber));

      setSaveJumpStatus("");
      setLogbookStatus("Saved jump loaded into Analyzer.");
      window.setTimeout(() => {
        logbookSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);

      const validatedJump = getValidatedJumpTrack(
        workingTrackPoints,
        dzElevationNumber
      );
      const detectedJumpTrack = getDetectedJumpTrack(workingTrackPoints);
      const exitPoint =
        validatedJump.exitPoint ?? detectedJumpTrack.exitPoint;

      if (
        !exitPoint ||
        exitPoint.timestampMs === null
      ) {
        setHistoricalWindStatus(
          "Historical winds could not be loaded because no timestamped jump exit was detected."
        );
        return;
      }

      try {
        const importedWinds = await fetchHistoricalWindProfile({
          latitude: exitPoint.lat,
          longitude: exitPoint.lon,
          timestampMs: exitPoint.timestampMs,
          dzElevationM: dzElevationNumber,
        });

        setHistoricalWinds(importedWinds);
        setHistoricalWindStatus(
          `Loaded ${importedWinds.length} historical wind levels.`
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown historical wind error.";

        setHistoricalWindStatus(
          `Could not load historical winds: ${message}`
        );
      }
    }

    async function saveEditedJump() {
    if (!editingJumpId) {
      return;
    }

    setLogbookStatus("Saving changes...");

    const { error } = await supabase
      .from("jumps")
      .update({
        location_name: editLocationName.trim() || null,
        suit_name: editSuitName.trim() || null,
        notes: editNotes.trim() || null,
      })
      .eq("id", editingJumpId);

    if (error) {
      setLogbookStatus(`Could not save changes: ${error.message}`);
      return;
    }

    setEditingJumpId(null);
    setLogbookStatus("Changes saved.");
    void loadSavedJumps();
  }

  async function deleteSavedJump(jumpId: string) {
    const confirmed = window.confirm(
      "Delete this saved jump? This cannot be undone."
    );

  if (!confirmed) {
    return;
  }

    setLogbookStatus("Deleting jump...");

    const { error } = await supabase
      .from("jumps")
      .delete()
      .eq("id", jumpId);

    if (error) {
      setLogbookStatus(`Could not delete jump: ${error.message}`);
      return;
    }

    setEditingJumpId(null);
    setLogbookStatus("Jump deleted.");
    void loadSavedJumps();
  }

  const [activePage, setActivePage] = useState<AppPage>(getSavedAppPage);
  const [appMode, setAppMode] = useState<AppMode>(() =>
  window.matchMedia("(min-width: 900px)").matches
    ? "desktop"
    : "phone"
);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 900px)");

    const updateAppMode = (event: MediaQueryListEvent) => {
      setAppMode(event.matches ? "desktop" : "phone");
    };

    mediaQuery.addEventListener("change", updateAppMode);

    return () => {
      mediaQuery.removeEventListener("change", updateAppMode);
  };
}, []);

useEffect(() => {
  try {
    window.sessionStorage.setItem(APP_PAGE_STORAGE_KEY, activePage);
  } catch {
    // The app still works when browser storage is unavailable.
  }
}, [activePage]);

useEffect(() => {
  if (activePage !== "lane") {
    return;
  }

  const timer = window.setTimeout(() => {
    saveLaneButtonRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, 500);

  return () => window.clearTimeout(timer);
}, [activePage]);

const [rulesSearchQuery, setRulesSearchQuery] = useState("");
  const [activeFindHelp, setActiveFindHelp] = useState<
    "speed" | "time" | "distance" | null
  >(null);
  const [savedLaneAvailable, setSavedLaneAvailable] = useState(false);
  const [gpsFileName, setGpsFileName] = useState("");
  const [dzElevationM, setDzElevationM] = useState("");
  const [windowOffsetM, setWindowOffsetM] = useState(0);
  const [gpsTrackPoints, setGpsTrackPoints] = useState<GpsTrackPoint[]>([]);
  const [ignoredGroundSampleCount, setIgnoredGroundSampleCount] = useState(0);
  const [rawGpsCsv, setRawGpsCsv] = useState("");
  const [showCompareSelector, setShowCompareSelector] = useState(false);
  const [compareOptions, setCompareOptions] = useState<CompareTrackOption[]>([]);
  const [selectedCompareTrackIds, setSelectedCompareTrackIds] = useState<string[]>([]);
  const [compareScrollRequested, setCompareScrollRequested] = useState(false);
  const [compareStatus, setCompareStatus] = useState("");
  const [historicalWinds, setHistoricalWinds] = useState<WindLayer[]>([]);
  const [historicalWindStatus, setHistoricalWindStatus] = useState("");
  const [taskMode, setTaskMode] = useState<TaskMode>("distance");

  const [windSource, setWindSource] =
    useState<WindSource>("open-meteo");

  const [forecastHourOffset, setForecastHourOffset] = useState(0);

  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState("");
  const [startGR, setStartGR] = useState("");
  const [endGR, setEndGR] = useState("");

  const [savedDistanceSpeedKph, setSavedDistanceSpeedKph] = useState("");
  const [savedTimeSpeedKph, setSavedTimeSpeedKph] = useState("");

  const [runHeadingDeg, setRunHeadingDeg] = useState("");
  const [, setShowTemporaryFlightLine] = useState(false);
  const [dropDistanceNm, setDropDistanceNm] = useState("");
  const dropDistanceInputRef = useRef<HTMLInputElement | null>(null);
  const referenceButtonRef = useRef<HTMLButtonElement | null>(null);
  const mapPickerSectionRef = useRef<HTMLDivElement | null>(null);
  const flyMyLaneButtonRef = useRef<HTMLButtonElement | null>(null);
  const saveLaneButtonRef = useRef<HTMLButtonElement | null>(null);
  const logbookSectionRef = useRef<HTMLElement | null>(null);
  const compareChartSectionRef = useRef<HTMLDivElement | null>(null);

  const visibleSavedJumps = useMemo(() => {
    const { filters, remainingQuery } =
      getLogbookComparisonFilters(logbookSearchQuery);
    const ignoredSearchWords = new Set([
      "all",
      "track",
      "tracks",
      "jump",
      "jumps",
      "that",
      "are",
      "with",
    ]);
    const searchWords = remainingQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word && !ignoredSearchWords.has(word));

    if (searchWords.length === 0 && filters.length === 0) {
      return savedJumps;
    }

    return savedJumps.filter((jump) => {
      const meetsComparisonFilters = filters.every((filter) => {
        if (filter.metric === "any") {
          return [
            jump.window_speed_kmh,
            jump.window_time_s,
            jump.window_distance_m,
          ].some(
            (score) =>
              score !== null && Number.isFinite(score) && score > filter.value
          );
        }

        const score = getLogbookScoreForTask(jump, filter.metric);
        return score !== null && Number.isFinite(score) && score > filter.value;
      });

      if (!meetsComparisonFilters) {
        return false;
      }

      const searchableText = [
        formatLogbookDateTime(jump.jump_date),
        jump.task_type,
        jump.location_name,
        jump.suit_name,
        jump.notes,
        jump.window_time_s !== null ? `${formatNumber(jump.window_time_s, 2)} sec` : null,
        jump.window_distance_m !== null
          ? `${formatNumber(jump.window_distance_m, 1)} m`
          : null,
        jump.window_speed_kmh !== null
          ? `${formatNumber(jump.window_speed_kmh, 1)} km/h`
          : null,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchWords.every((word) => searchableText.includes(word));
    });
  }, [logbookSearchQuery, savedJumps]);

  const selectedCompareTracks = compareOptions.filter((option) =>
    selectedCompareTrackIds.includes(option.id)
  );

  useEffect(() => {
    if (!compareScrollRequested || selectedCompareTracks.length === 0) {
      return;
    }

    window.setTimeout(() => {
      compareChartSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
    setCompareScrollRequested(false);
  }, [compareScrollRequested, selectedCompareTracks.length]);

  function getSavedJumpCompareOption(jump: SavedJump): CompareTrackOption | null {
    if (!jump.raw_csv) {
      return null;
    }

    const labelParts = [
      formatLogbookDateTime(jump.jump_date),
      jump.task_type
        ? formatLogbookTrackType(jump.task_type)
        : null,
      jump.location_name,
      jump.suit_name,
    ].filter(Boolean);

    return {
      id: "saved-" + jump.id,
      label: labelParts.join(" - "),
      rawCsv: jump.raw_csv,
      dzElevationM: jump.dz_elevation_m ?? 0,
      taskType: jump.task_type,
    };
  }

  function openCompareTracksSelector() {
    setShowCompareSelector(true);
    setCompareStatus(
      "Choose tracks from the logbook below. Selected tracks will appear here."
    );
  }

  function toggleCompareTrack(option: CompareTrackOption) {
    const optionId = option.id;

    setSelectedCompareTrackIds((currentIds) => {
      if (currentIds.includes(optionId)) {
        setCompareOptions((currentOptions) =>
          currentOptions.filter((currentOption) => currentOption.id !== optionId)
        );
        return currentIds.filter((id) => id !== optionId);
      }

      if (currentIds.length >= 6) {
        setCompareStatus("Maximum 6 tracks can be compared.");
        return currentIds;
      }

      setCompareOptions((currentOptions) => {
        if (currentOptions.some((currentOption) => currentOption.id === optionId)) {
          return currentOptions;
        }

        return [...currentOptions, option];
      });
      setCompareStatus("Select up to 6 tracks.");
      return [...currentIds, optionId];
    });
  }

  function toggleSavedJumpCompare(jump: SavedJump) {
    const compareOption = getSavedJumpCompareOption(jump);

    if (!compareOption) {
      setCompareStatus("This saved jump does not contain the original CSV.");
      return;
    }

    toggleCompareTrack(compareOption);
  }
  

  const [globalWindFromDeg, setGlobalWindFromDeg] = useState("");
  const [globalWindSpeedKt, setGlobalWindSpeedKt] = useState("");

  const [referenceLat, setReferenceLat] = useState("");
  const [referenceLon, setReferenceLon] = useState("");
  const [competitionReferenceLat, setCompetitionReferenceLat] = useState("");
  const [competitionReferenceLon, setCompetitionReferenceLon] = useState("");
  const [showCompetitionReferencePicker, setShowCompetitionReferencePicker] =
    useState(false);
  const [competitionReferenceGroupId, setCompetitionReferenceGroupId] =
    useState<string | null>(null);

      useEffect(() => {
      if (windSource !== "open-meteo" && windSource !== "meteomatics") {
        return;
      }

      const lat = optionalNumberFromInput(referenceLat);
      const lon = optionalNumberFromInput(referenceLon);

      if (lat === null || lon === null) {
        return;
      }

      if (windSource === "open-meteo") {
        void fetchOpenMeteoWithMeteomaticsFallback(lat, lon);
      }

      if (windSource === "meteomatics") {
        void fetchMeteomaticsWindsForLocationWithStatus(lat, lon);
      }
    }, [
      windSource,
      referenceLat,
      referenceLon,
      forecastHourOffset,
    ]);


  const [userMapLocation, setUserMapLocation] = useState<LatLon | null>(null);
  const [locationStatus, setLocationStatus] = useState("");

  const [fetchStatus, setFetchStatus] = useState("");
  const [referenceStatus, setReferenceStatus] = useState("");
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [showLatLonEntry, setShowLatLonEntry] = useState(false);
  const [referenceLatInput, setReferenceLatInput] = useState("");
  const [referenceLonInput, setReferenceLonInput] = useState("");
  const [latLonEntryError, setLatLonEntryError] = useState("");
  const [showSavedReferencePoints, setShowSavedReferencePoints] =
    useState(false);
  const [savedReferencePointStore, setSavedReferencePointStore] =
    useState<SavedReferencePointStore>(getSavedReferencePointStore);
  const [newReferenceGroupName, setNewReferenceGroupName] = useState("");
  const [savedReferencePointName, setSavedReferencePointName] = useState("");
  const [savedReferencePointStatus, setSavedReferencePointStatus] =
    useState("");

  const selectedReferencePointGroup =
    savedReferencePointStore.groups.find(
      (group) => group.id === savedReferencePointStore.activeGroupId,
    ) ?? null;
  const selectedCompetitionReferenceGroup =
    savedReferencePointStore.groups.find(
      (group) => group.id === competitionReferenceGroupId,
    ) ?? null;
  const totalSavedReferencePoints = savedReferencePointStore.groups.reduce(
    (total, group) => total + group.points.length,
    0,
  );
  const selectedSavedReferencePointsForMap = useMemo(() => {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (selectedReferencePointGroup === null || lat === null || lon === null) {
      return NO_SAVED_REFERENCE_POINTS;
    }

    const selectedPoint = selectedReferencePointGroup.points.find(
      (point) =>
        Math.abs(point.lat - lat) < 0.000001 &&
        Math.abs(point.lon - lon) < 0.000001,
    );

    return selectedPoint ? [selectedPoint] : NO_SAVED_REFERENCE_POINTS;
  }, [referenceLat, referenceLon, selectedReferencePointGroup]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        REFERENCE_POINT_GROUPS_STORAGE_KEY,
        JSON.stringify(savedReferencePointStore),
      );
    } catch {
      setSavedReferencePointStatus(
        "Reference points could not be saved by this browser.",
      );
    }
  }, [savedReferencePointStore]);

  useEffect(() => {
  if (!showMapPicker) {
    return;
  }

  const timer = window.setTimeout(() => {
    const elementTop =
      mapPickerSectionRef.current?.getBoundingClientRect().top ?? 0;

    const targetScrollY = window.scrollY + elementTop + 80;

    window.scrollTo({
      top: targetScrollY,
      behavior: "smooth",
    });
  }, 150);

  return () => window.clearTimeout(timer);
}, [showMapPicker]);

  const [showRawWinds, setShowRawWinds] = useState(false);
  const [winds, setWinds] = useState<WindLayer[]>(defaultWinds);

  const [configTask, setConfigTask] = useState<ConfigTask>("distance");
  const [configSuit, setConfigSuit] =
    useState<ConfigSuit>("crplus-no-wingtips");
  const [configDzElevM, setConfigDzElevM] = useState("");
  const [configTimezoneOffsetHours, setConfigTimezoneOffsetHours] =
    useState("");

  const [configToneMin, setConfigToneMin] = useState("");
  const [configToneMax, setConfigToneMax] = useState("");

  const [storedConfigTonePresets, setStoredConfigTonePresets] =
    useState<StoredConfigTonePresets>({});

  const [configAlarm9, setConfigAlarm9] = useState("3353");
  const [configAlarm5, setConfigAlarm5] = useState("3000");
  const [configAlarm4, setConfigAlarm4] = useState("2900");
  const [configAlarm3, setConfigAlarm3] = useState("2800");
  const [configAlarm2, setConfigAlarm2] = useState("2700");
  const [configAlarm1, setConfigAlarm1] = useState("2600");
  const [configAlarmBeep, setConfigAlarmBeep] = useState("2500");
  const [configAlarmFlare, setConfigAlarmFlare] = useState("1600");
  const [configAlarmTask, setConfigAlarmTask] = useState("1450");
  const [showAlarmHelp, setShowAlarmHelp] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    if (!showAlarmHelp) {
      return;
    }

    function closeAlarmHelpOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowAlarmHelp(false);
      }
    }

    window.addEventListener("keydown", closeAlarmHelpOnEscape);
    return () => window.removeEventListener("keydown", closeAlarmHelpOnEscape);
  }, [showAlarmHelp]);

  const foundNumbers = useMemo(
    () =>
      calculateFindYourNumbers({
        weight: findWeight,
        unitSystem: findUnitSystem,
        heightCm: findHeightCm,
        heightFeet: findHeightFeet,
        heightInches: findHeightInches,
        suitSetup: findSuitSetup,
      }),
    [
      findWeight,
      findUnitSystem,
      findHeightCm,
      findHeightFeet,
      findHeightInches,
      findSuitSetup,
    ]
  );

  const calculatedFindNumbers: SavedFindNumbers = {
    distanceSpeedKph: String(foundNumbers.distanceSpeedKph),
    timeSpeedKph: String(foundNumbers.timeSpeedKph),
    speedStartGR: foundNumbers.speedStartGR.toFixed(2),
    speedEndGR: foundNumbers.speedEndGR.toFixed(2),
  };
  const editableFindNumbers = findNumbersOverride ?? calculatedFindNumbers;
  const findNumbersAreValid = areFindNumbersValid(editableFindNumbers);

  const hasFindInputs =
  findWeight.trim() !== "" &&
  (findUnitSystem === "metric"
    ? findHeightCm.trim() !== ""
    : findHeightFeet.trim() !== "" || findHeightInches.trim() !== "") &&
  findSuitSetup !== "";

  const generatedConfigText = useMemo(
    () =>
            generateFlySightConfig({
        task: configTask,
        dzElevM: configDzElevM,
        timezoneOffsetHours: configTimezoneOffsetHours,
        toneMin: configToneMin,
        toneMax: configToneMax,
        alarm9: configAlarm9,
        alarm5: configAlarm5,
        alarm4: configAlarm4,
        alarm3: configAlarm3,
        alarm2: configAlarm2,
        alarm1: configAlarm1,
        alarmBeep: configAlarmBeep,
        alarmFlare: configAlarmFlare,
        alarmTask: configAlarmTask,
      }),
        [
      configTask,
      configDzElevM,
      configTimezoneOffsetHours,
      configToneMin,
      configToneMax,
      configAlarm9,
      configAlarm5,
      configAlarm4,
      configAlarm3,
      configAlarm2,
      configAlarm1,
      configAlarmBeep,
      configAlarmFlare,
      configAlarmTask,
    ]
  );

  const toneMinNumber = optionalNumberFromInput(configToneMin);
  const toneMaxNumber = optionalNumberFromInput(configToneMax);
  const toneRangeInvalid =
  toneMinNumber !== null &&
  toneMaxNumber !== null &&
  toneMaxNumber <= toneMinNumber;
  const windAdvantage = useMemo(
    () =>
      calculateWindAdvantageSummary(numberFromInput(runHeadingDeg, 0), winds),
    [runHeadingDeg, winds]
  );

  const calculatedDropPoint = useMemo(() => {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);
    const heading = optionalNumberFromInput(runHeadingDeg);
    const distanceNm = optionalNumberFromInput(dropDistanceNm);

    if (
      lat === null ||
      lon === null ||
      heading === null ||
      distanceNm === null ||
      distanceNm <= 0
    ) {
      return null;
    }

    return calculateDropPoint(lat, lon, heading, distanceNm);
  }, [referenceLat, referenceLon, runHeadingDeg, dropDistanceNm]);

  function requestUserMapLocation() {
    if (!navigator.geolocation) {
      setLocationStatus("Location is not supported by this browser.");
      return;
    }

    setLocationStatus("Finding your location...");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLocation = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };

        const accuracyM = Math.round(position.coords.accuracy);

        setUserMapLocation(nextLocation);
        setLocationStatus(
          `Map centred near your location. Accuracy about ${accuracyM} m. Tap the map to choose the reference point.`
        );
      },
      (error) => {
        setLocationStatus(
          `Could not get your location. ${error.message}. You can still zoom the map manually.`
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  }

  function toggleMapPicker() {
    const openingMap = !showMapPicker;

    setShowMapPicker(openingMap);

    if (!openingMap) {
      setShowLatLonEntry(false);
    }

    if (openingMap && userMapLocation === null) {
      requestUserMapLocation();
    }
  }

  function openReferenceMapAndScroll() {
    setShowLatLonEntry(false);
    setShowMapPicker(true);

    window.setTimeout(() => {
      mapPickerSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 200);
  }

  function toggleLatLonEntry() {
    const openingEntry = !showLatLonEntry;

    setShowLatLonEntry(openingEntry);
    setLatLonEntryError("");

    if (!openingEntry) {
      return;
    }

    setReferenceLatInput(referenceLat);
    setReferenceLonInput(referenceLon);
    setShowMapPicker(true);
  }

  function toggleFindUnitSystem() {
    setFindDetailsStatus("");

    if (findUnitSystem === "metric") {
      const weightKg = optionalNumberFromInput(findWeight);
      if (weightKg !== null) {
        setFindWeight(String(Math.round(kgToLb(weightKg))));
      }

      const heightCm = optionalNumberFromInput(findHeightCm);
      if (heightCm !== null) {
        const split = splitInchesToFeetAndInches(cmToInches(heightCm));
        setFindHeightFeet(String(split.feet));
        setFindHeightInches(String(split.inches));
      }

      setFindUnitSystem("imperial");
      return;
    }

    const weightLb = optionalNumberFromInput(findWeight);
    if (weightLb !== null) {
      setFindWeight(String(Math.round(lbToKg(weightLb))));
    }

    const totalInches = feetAndInchesToTotalInches(
      findHeightFeet,
      findHeightInches
    );

    if (totalInches > 0) {
      setFindHeightCm(String(Math.round(inchesToCm(totalInches))));
    }

    setFindUnitSystem("metric");
  }

  function updateFindNumber(
    field: keyof SavedFindNumbers,
    value: string,
  ) {
    setFindNumbersOverride((currentNumbers) => ({
      ...(currentNumbers ?? calculatedFindNumbers),
      [field]: value,
    }));
    setFindDetailsStatus("");
  }

  function resetFindNumbersToEstimates() {
    setFindNumbersOverride(null);
    setFindDetailsStatus("Your calculated estimates have been restored.");
  }

  async function saveFindDetails() {
    if (!supabaseSession) {
      setFindDetailsStatus("Your signed-in session is still loading. Please try again.");
      return;
    }

    if (!hasFindInputs || !findSuitSetup) {
      setFindDetailsStatus("Enter your height, weight and suit before saving.");
      return;
    }

    if (!findNumbersAreValid) {
      setFindDetailsStatus(
        "Enter positive target numbers, with the Speed end GR above the start GR.",
      );
      return;
    }

    const savedDetails: SavedFindDetails = {
      version: 1,
      unitSystem: findUnitSystem,
      weight: findWeight,
      heightCm: findHeightCm,
      heightFeet: findHeightFeet,
      heightInches: findHeightInches,
      suitSetup: findSuitSetup,
      numbers: { ...editableFindNumbers },
    };

    setFindDetailsBusy(true);
    setFindDetailsStatus("");

    const { error } = await supabase.auth.updateUser({
      data: {
        [FIND_DETAILS_METADATA_KEY]: savedDetails,
      },
    });

    if (error) {
      setFindDetailsStatus(`Could not save your details: ${error.message}`);
    } else {
      setFindNumbersOverride({ ...editableFindNumbers });
      setFindDetailsStatus(
        "Your details and target numbers have been saved to your account.",
      );
    }

    setFindDetailsBusy(false);
  }

function syncFoundNumbersToFlyPage(nextTaskMode: TaskMode = taskMode) {
  const distanceSpeed = editableFindNumbers.distanceSpeedKph;
  const timeSpeed = editableFindNumbers.timeSpeedKph;
  const speedStart = editableFindNumbers.speedStartGR;
  const speedEnd = editableFindNumbers.speedEndGR;

  setSavedDistanceSpeedKph(distanceSpeed);
  setSavedTimeSpeedKph(timeSpeed);
  setStartGR(speedStart);
  setEndGR(speedEnd);

  if (nextTaskMode === "distance") {
    setZeroWindSpeedKph(distanceSpeed);
  } else if (nextTaskMode === "time") {
    setZeroWindSpeedKph(timeSpeed);
  }
}

function openFlyNumbersPage() {
  if (hasFindInputs && findNumbersAreValid) {
    syncFoundNumbersToFlyPage();
  }

  setActivePage("fly");
}

function pushAllFoundNumbersToFlyPage() {
  syncFoundNumbersToFlyPage("distance");

  const nextConfigSuit = mapSuitSetupToConfigSuit(findSuitSetup);

  const bodyAdjustmentKph = getPilotBodyAdjustmentKph({
    weight: findWeight,
    unitSystem: findUnitSystem,
    heightCm: findHeightCm,
    heightFeet: findHeightFeet,
    heightInches: findHeightInches,
  });

  const distanceTonePreset = getConfigTonePreset({
    task: "distance",
    configSuit: nextConfigSuit,
    bodyAdjustmentKph,
  });

  setConfigSuit(nextConfigSuit);
  setConfigTask("distance");
  setConfigToneMin(String(distanceTonePreset.toneMin));
  setConfigToneMax(String(distanceTonePreset.toneMax));

  setTaskMode("distance");
  setActivePage("fly");
}

  function handleFlyTaskModeChange(nextTaskMode: TaskMode) {
    setTaskMode(nextTaskMode);

    if (nextTaskMode === "distance" && savedDistanceSpeedKph !== "") {
      setZeroWindSpeedKph(savedDistanceSpeedKph);
    }

    if (nextTaskMode === "time" && savedTimeSpeedKph !== "") {
      setZeroWindSpeedKph(savedTimeSpeedKph);
    }
  }

function useDeviceTimezoneForConfig() {
  const seconds = getDeviceTimezoneOffsetSeconds();
  const hours = seconds / 3600;

  setConfigTimezoneOffsetHours(String(hours));
  setCopyStatus(`Timezone set from this device: ${seconds} seconds.`);
}

function getConfigWindSummary(currentResults: ResultRow[]) {
  if (currentResults.length === 0) {
    return {
      averageTailwindKt: 0,
      averageCrosswindKt: 0,
    };
  }

  const averageTailwindKt =
    currentResults.reduce((total, row) => total + row.tailwindKt, 0) / currentResults.length;

  const averageCrosswindKt =
    currentResults.reduce((total, row) => total + Math.abs(row.crosswindKt), 0) /
    currentResults.length;

  return {
    averageTailwindKt,
    averageCrosswindKt,
  };
}

function calculateConfigTonePresetForTask(
  nextTask: ConfigTask,
  nextSuit: ConfigSuit
): {
  toneMin: string;
  toneMax: string;
} {
  const bodyAdjustmentKph = getPilotBodyAdjustmentKph({
    weight: findWeight,
    unitSystem: findUnitSystem,
    heightCm: findHeightCm,
    heightFeet: findHeightFeet,
    heightInches: findHeightInches,
  });

  const tonePreset = getConfigTonePreset({
    task: nextTask,
    configSuit: nextSuit,
    bodyAdjustmentKph,
  });

  const windSummary = getConfigWindSummary(results);

  if (nextTask === "distance") {
    return {
      toneMin: String(
        windAdjustedDistanceGR(
          tonePreset.toneMin,
          windSummary.averageTailwindKt
        )
      ),
      toneMax: String(
        windAdjustedDistanceGR(
          tonePreset.toneMax,
          windSummary.averageTailwindKt
        )
      ),
    };
  }

  if (nextTask === "speed") {
    return {
      toneMin: String(
        windAdjustedSpeedToneKph(tonePreset.toneMin, windSummary.averageTailwindKt)
      ),
      toneMax: String(
        windAdjustedSpeedToneKph(tonePreset.toneMax, windSummary.averageTailwindKt)
      ),
    };
  }

  return {
    toneMin: String(tonePreset.toneMin),
    toneMax: String(tonePreset.toneMax),
  };
}function applyConfigTonePreset(nextTask: ConfigTask, nextSuit: ConfigSuit) {
  const tonePreset = calculateConfigTonePresetForTask(nextTask, nextSuit);

  setConfigToneMin(tonePreset.toneMin);
  setConfigToneMax(tonePreset.toneMax);
}

function applyConfigAlarmDefaults(nextTask: ConfigTask) {
  if (nextTask === "speed") {
    setConfigAlarm5("3100");
    setConfigAlarm4("3000");
    setConfigAlarm3("2900");
    setConfigAlarm2("2800");
    setConfigAlarm1("2700");
    setConfigAlarmBeep("2600");
    return;
  }

  setConfigAlarm5("3000");
  setConfigAlarm4("2900");
  setConfigAlarm3("2800");
  setConfigAlarm2("2700");
  setConfigAlarm1("2600");
  setConfigAlarmBeep("2500");
}

function updateConfigSuit(nextSuit: ConfigSuit) {
  setConfigSuit(nextSuit);
  applyConfigTonePreset(configTask, nextSuit);
}

function pushFlyNumbersToConfig() {
  const distanceTonePreset = calculateConfigTonePresetForTask(
    "distance",
    configSuit
  );

  const speedTonePreset = calculateConfigTonePresetForTask(
    "speed",
    configSuit
  );

  const timeTonePreset = calculateConfigTonePresetForTask(
    "time",
    configSuit
  );

  storeConfigTonePreset(
    "distance",
    distanceTonePreset.toneMin,
    distanceTonePreset.toneMax
  );

  storeConfigTonePreset(
    "speed",
    speedTonePreset.toneMin,
    speedTonePreset.toneMax
  );

  storeConfigTonePreset(
    "time",
    timeTonePreset.toneMin,
    timeTonePreset.toneMax
  );

  setConfigTask(taskMode);
  setConfigToneMin(
    taskMode === "distance"
      ? distanceTonePreset.toneMin
      : taskMode === "speed"
        ? speedTonePreset.toneMin
        : timeTonePreset.toneMin
  );
  setConfigToneMax(
    taskMode === "distance"
      ? distanceTonePreset.toneMax
      : taskMode === "speed"
        ? speedTonePreset.toneMax
        : timeTonePreset.toneMax
  );

  setCopyStatus("Fly numbers pushed to Config the Numbers.");
  setActivePage("config");

window.setTimeout(() => {
  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
}, 0);
}

function storeConfigTonePreset(
  task: ConfigTask,
  toneMin: string,
  toneMax: string
) {
  setStoredConfigTonePresets((currentPresets) => ({
    ...currentPresets,
    [task]: {
      toneMin,
      toneMax,
    },
  }));
}

async function copyGeneratedConfig() {
  if (toneRangeInvalid) {
    setCopyStatus("Fix the tone range before copying the config.");
    return;
  }

  try {
    await navigator.clipboard.writeText(generatedConfigText);
    setCopyStatus("Config copied.");
  } catch {
    setCopyStatus("Could not copy config. You can manually select the text.");
  }
}

function downloadGeneratedConfig() {
    if (toneRangeInvalid) {
    setCopyStatus("Fix the tone range before downloading the config.");
    return;
  }

  downloadTextFile(`${configTask}.TXT`, generatedConfigText);
}  function updateWind(
    altitudeM: number,
    field: "directionFromDeg" | "speedKt",
    value: string
  ) {
    setWinds((currentWinds) =>
      currentWinds.map((wind) =>
        wind.altitudeM === altitudeM ? { ...wind, [field]: value } : wind
      )
    );
  }

  function applyGlobalWindToAll() {
    setWinds((currentWinds) =>
      currentWinds.map((wind) => ({
        ...wind,
        directionFromDeg: globalWindFromDeg,
        speedKt: globalWindSpeedKt,
      }))
    );
  }

  function updateHeadingFromSlider(value: string) {
    setRunHeadingDeg(value);
  }

  async function fetchMarkSchulzeWindsForLocation(lat: number, lon: number) {
    setFetchStatus("Fetching Mark Schulze winds...");

    const url = `${windProxyUrl}/?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&hourOffset=0`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = (await response.json()) as MarkSchulzeResponse;
      const importedWinds = mapMarkSchulzeToWindLayers(data);

      setWinds(importedWinds);
      setFetchStatus(`Loaded ${data.model ?? "forecast"} winds.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while fetching winds.";

      setFetchStatus(`Could not fetch Mark Schulze winds, switch to Open Meteo. ${message}.`);
    }
  }

  async function fetchMeteomaticsWindsForLocation(
    lat: number,
    lon: number,
    statusPrefix = "Fetching Meteomatics winds..."
  ) {
    setFetchStatus(statusPrefix);

    const url = `${windProxyUrl}/meteomatics?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&hourOffset=${encodeURIComponent(
      forecastHourOffset
    )}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Meteomatics request failed with status ${response.status}`);
    }

    const data = (await response.json()) as MeteomaticsProxyResponse;
    const importedWinds = mapMeteomaticsToWindLayers(data);

    setWinds(importedWinds);
    setFetchStatus(`Loaded ${data.model ?? "Meteomatics"} forecast winds.`);
  }


  async function fetchOpenMeteoWindsForLocation(lat: number, lon: number) {
  setFetchStatus("Fetching Open-Meteo winds...");

  const hourlyFields = [
    "wind_speed_1000hPa",
    "wind_direction_1000hPa",
    "wind_speed_925hPa",
    "wind_direction_925hPa",
    "wind_speed_850hPa",
    "wind_direction_850hPa",
    "wind_speed_700hPa",
    "wind_direction_700hPa",
  ].join(",");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(
      lat
    )}&longitude=${encodeURIComponent(
      lon
    )}&hourly=${encodeURIComponent(hourlyFields)}&wind_speed_unit=kn`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = (await response.json()) as OpenMeteoResponse;
    const importedWinds = mapOpenMeteoToWindLayers(data, forecastHourOffset);

    setWinds(importedWinds);
    setFetchStatus("Loaded Open-Meteo forecast winds.");
}

  async function fetchOpenMeteoWithMeteomaticsFallback(lat: number, lon: number) {
  try {
    await fetchOpenMeteoWindsForLocation(lat, lon);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error while fetching winds.";

    try {
      await fetchMeteomaticsWindsForLocation(
        lat,
        lon,
        `Open-Meteo unavailable (${message}). Fetching Meteomatics fallback...`
      );
      setWindSource("meteomatics");
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : "Unknown error while fetching Meteomatics winds.";

      setFetchStatus(
        `Could not fetch Open-Meteo winds (${message}) or Meteomatics fallback (${fallbackMessage}). Use raw winds or try again later.`
      );
    }
  }
}

  async function fetchMeteomaticsWindsForLocationWithStatus(
    lat: number,
    lon: number
  ) {
    try {
      await fetchMeteomaticsWindsForLocation(lat, lon);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while fetching Meteomatics winds.";

      setFetchStatus(
        `Could not fetch Meteomatics winds. ${message}. Use raw winds or try again later.`
    );
  }
}
  async function setReferencePoint(lat: number, lon: number, sourceLabel: string) {
    const nextLat = lat.toFixed(6);
    const nextLon = lon.toFixed(6);

    setReferenceLat(nextLat);
    setReferenceLon(nextLon);
    setReferenceStatus(
      `Reference point set from ${sourceLabel}: ${nextLat}, ${nextLon}.`
    );

    if (windSource === "mark-schulze") {
      await fetchMarkSchulzeWindsForLocation(lat, lon);
    }

    if (windSource === "open-meteo") {
      await fetchOpenMeteoWithMeteomaticsFallback(lat, lon);
    }

    if (windSource === "meteomatics") {
      await fetchMeteomaticsWindsForLocationWithStatus(lat, lon);
    }
  }

  async function pickReferenceFromMap(lat: number, lon: number) {
    await setReferencePoint(lat, lon, "map");
  }

  async function handleLatLonReferenceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const lat = optionalNumberFromInput(referenceLatInput);
    const lon = optionalNumberFromInput(referenceLonInput);

    if (lat === null || lon === null) {
      setLatLonEntryError("Enter a valid latitude and longitude.");
      return;
    }

    if (lat < -90 || lat > 90) {
      setLatLonEntryError("Latitude must be between -90 and 90.");
      return;
    }

    if (lon < -180 || lon > 180) {
      setLatLonEntryError("Longitude must be between -180 and 180.");
      return;
    }

    setLatLonEntryError("");
    await setReferencePoint(lat, lon, "Lat/Lon entry");
  }

  function selectReferencePointGroup(groupId: string) {
    const nextGroupId = groupId || null;

    setSavedReferencePointStore((currentStore) => ({
      ...currentStore,
      activeGroupId: nextGroupId,
    }));
    setNewReferenceGroupName("");
    setSavedReferencePointName("");
    setSavedReferencePointStatus("");

    if (nextGroupId) {
      openReferenceMapAndScroll();
    }
  }

  function saveCurrentReferencePoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat === null || lon === null) {
      setSavedReferencePointStatus(
        "Choose or enter a reference point before saving it.",
      );
      return;
    }

    const requestedGroupName = newReferenceGroupName.trim();
    let targetGroup = selectedReferencePointGroup;

    if (!targetGroup && requestedGroupName) {
      targetGroup =
        savedReferencePointStore.groups.find(
          (group) =>
            group.name.toLocaleLowerCase() ===
            requestedGroupName.toLocaleLowerCase(),
        ) ?? null;
    }

    if (!targetGroup && !requestedGroupName) {
      setSavedReferencePointStatus("Enter a competition location name.");
      return;
    }

    const groupWasCreated = targetGroup === null;
    const points = targetGroup?.points ?? [];
    const pointName =
      savedReferencePointName.trim() || `Reference ${points.length + 1}`;
    const existingPoint = points.find(
      (point) =>
        point.name.toLocaleLowerCase() === pointName.toLocaleLowerCase(),
    );

    if (!existingPoint && points.length >= MAX_REFERENCE_POINTS_PER_GROUP) {
      setSavedReferencePointStatus(
        `This location already has ${MAX_REFERENCE_POINTS_PER_GROUP} reference points. Delete or update one before adding another.`,
      );
      return;
    }

    const savedPoint: SavedReferencePoint = {
      id: existingPoint?.id ?? createReferencePointId(),
      name: pointName,
      lat,
      lon,
    };
    const nextPoints = existingPoint
      ? points.map((point) =>
          point.id === existingPoint.id ? savedPoint : point,
        )
      : [...points, savedPoint];
    const nextGroup: SavedReferencePointGroup = {
      id: targetGroup?.id ?? createReferencePointId(),
      name: targetGroup?.name ?? requestedGroupName,
      points: nextPoints,
    };
    const nextGroups = groupWasCreated
      ? [...savedReferencePointStore.groups, nextGroup]
      : savedReferencePointStore.groups.map((group) =>
          group.id === nextGroup.id ? nextGroup : group,
        );

    setSavedReferencePointStore({
      version: 1,
      activeGroupId: nextGroup.id,
      groups: nextGroups,
    });
    setNewReferenceGroupName("");
    setSavedReferencePointName("");
    setSavedReferencePointStatus(
      `${existingPoint ? "Updated" : "Saved"} ${savedPoint.name} in ${nextGroup.name}.`,
    );
  }

  async function loadSavedReferencePoint(
    group: SavedReferencePointGroup,
    point: SavedReferencePoint,
  ) {
    setSavedReferencePointStatus(`Loading ${point.name}...`);
    openReferenceMapAndScroll();
    await setReferencePoint(point.lat, point.lon, `${group.name} / ${point.name}`);
    setSavedReferencePointStatus(`Loaded ${point.name} from ${group.name}.`);
  }

  function selectAnalyzerSavedReferencePoint(
    group: SavedReferencePointGroup,
    point: SavedReferencePoint,
  ) {
    setCompetitionReferenceGroupId(group.id);
    setCompetitionReferenceLat(point.lat.toFixed(6));
    setCompetitionReferenceLon(point.lon.toFixed(6));
    setShowCompetitionReferencePicker(true);

    window.setTimeout(() => {
      document
        .querySelector(".competition-lane-card .map-picker")
        ?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
    }, 150);
  }

  function deleteSavedReferencePoint(
    group: SavedReferencePointGroup,
    point: SavedReferencePoint,
  ) {
    const confirmed = window.confirm(
      `Delete ${point.name} from ${group.name}?`,
    );

    if (!confirmed) {
      return;
    }

    setSavedReferencePointStore((currentStore) => ({
      ...currentStore,
      groups: currentStore.groups.map((currentGroup) =>
        currentGroup.id === group.id
          ? {
              ...currentGroup,
              points: currentGroup.points.filter(
                (currentPoint) => currentPoint.id !== point.id,
              ),
            }
          : currentGroup,
      ),
    }));
    setSavedReferencePointStatus(`Deleted ${point.name} from ${group.name}.`);
  }

  function deleteSavedReferencePointGroup(group: SavedReferencePointGroup) {
    const confirmed = window.confirm(
      `Delete ${group.name} and all ${group.points.length} saved reference points?`,
    );

    if (!confirmed) {
      return;
    }

    const remainingGroups = savedReferencePointStore.groups.filter(
      (currentGroup) => currentGroup.id !== group.id,
    );

    setSavedReferencePointStore({
      version: 1,
      activeGroupId: remainingGroups[0]?.id ?? null,
      groups: remainingGroups,
    });
    setSavedReferencePointStatus(`Deleted the ${group.name} location group.`);
  }

async function handleWindSourceChange(source: WindSource) {
  setWindSource(source);
  setFetchStatus("");

  if (source === "manual") {
    setShowRawWinds(true);
    return;
  }

  setShowRawWinds(false);

  const lat = optionalNumberFromInput(referenceLat);
  const lon = optionalNumberFromInput(referenceLon);

  if (lat === null || lon === null) {
    return;
  }

  if (source === "mark-schulze") {
    await fetchMarkSchulzeWindsForLocation(lat, lon);
  }

  if (source === "open-meteo") {
    await fetchOpenMeteoWithMeteomaticsFallback(lat, lon);
  }

  if (source === "meteomatics") {
    await fetchMeteomaticsWindsForLocationWithStatus(lat, lon);
  }
}
  function openWindyVisualCheck() {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat === null || lon === null) {
      setReferenceStatus("Choose a reference point before opening Windy.");
      return;
    }

    window.open(buildWindyUrl(lat, lon), "_blank", "noopener,noreferrer");
  }

  const results = useMemo(
    () =>
      calculateTargets(
        taskMode,
        numberFromInput(zeroWindSpeedKph, 0),
        numberFromInput(startGR, 0),
        numberFromInput(endGR, 0),
        numberFromInput(runHeadingDeg, 0),
        winds
      ),
    [taskMode, zeroWindSpeedKph, startGR, endGR, runHeadingDeg, winds]
  );

if (activePage === "lane") {
  return (
    <main className="app">
      <header className="page-header">
        <button type="button" onClick={() => setActivePage("fly")}>
          Back to Fly the Numbers
        </button>

        <h1>Lane View</h1>
        <p className="subtitle">
          Flight lane based on your reference point, heading, and drop distance.
        </p>
      </header>

      <section className="card">
        <div className="competition-reference-actions">
          <button
            type="button"
            onClick={() =>
              setForecastHourOffset((current) => current - 1)
            }
          >
            -1 hour
          </button>

          <button
            type="button"
            onClick={() => setForecastHourOffset(0)}
          >
            Now
          </button>

          <button
            type="button"
            onClick={() =>
              setForecastHourOffset((current) => current + 1)
            }
          >
            +1 hour
          </button>
        </div>

        <p className="subtitle">
          Forecast time:{" "}
          <strong>
            {new Date(
              Date.now() + forecastHourOffset * 60 * 60 * 1000
            ).toLocaleString()}
          </strong>
        </p>
      </section>

      <section className="card">
        <LaneViewMap
          referenceLat={referenceLat}
          referenceLon={referenceLon}
          dropPoint={calculatedDropPoint}
          runHeadingDeg={runHeadingDeg}
          dropDistanceNm={dropDistanceNm}
          winds={winds}
        />
      </section>
      
      <section className="card">
        <button
          ref={saveLaneButtonRef}
          type="button"
          className={
            savedLaneAvailable
              ? "primary-action-button saved-lane-button"
              : "primary-action-button"
          }
          onClick={() => setSavedLaneAvailable(true)}
        >
          {savedLaneAvailable ? "Lane Saved ✓" : "Save my Lane"}
        </button>

        <p className="subtitle">
          {savedLaneAvailable
            ? "Your My Lane button is now available on the home page."
            : "Adds a My Lane button to the home page so you can quickly return to this lane view with the latest winds."}
        </p>
      </section>
      
      
      <BottomBackButton
        label="Back to Home"
        onClick={() => setActivePage("landing")}
      />

      <BottomBackButton
        label="Back to Fly the Numbers"
        onClick={() => setActivePage("fly")}
      />
    </main>
  );

      }

        if (activePage === "gps") {
        return (
          <main
            className={`app gps-analyzer-page ${
              appMode === "desktop" ? "gps-analyzer-desktop" : ""
            }`}
          >
            <header className="page-header">
              <button type="button" onClick={() => setActivePage("landing")}>
                Back to Home
              </button>

              <h1>GPS Track Analyzer</h1>
              <p className="subtitle">
                Import a FlySight CSV file to review wingsuit performance data.
              </p>
            </header>

            {showLogbookLogin && (
              <AuthModal
                session={supabaseSession}
                email={authEmail}
                status={authStatus}
                busy={authBusy}
                onEmailChange={setAuthEmail}
                onGoogleSignIn={handleGoogleSignIn}
                onGoogleSignInError={handleGoogleSignInError}
                onEmailLinkSignIn={handleEmailLinkSignIn}
                onSignOut={handleSignOut}
                onClose={() => setShowLogbookLogin(false)}
              />
            )}

            <section className="card gps-upload-card">
              <h2>Import FlySight CSV</h2>

              <label>
                DZ elevation (m)
                <input
                  type="number"
                  step="1"
                  value={dzElevationM}
                  placeholder="Example 13"
                  onChange={(event) => setDzElevationM(event.target.value)}
                />
              </label>

              <label>
                Choose GPS track file
                <input
                  type="file"
                  accept=".csv,.CSV"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];

                    if (!file) {
                      setGpsFileName("");
                      setGpsTrackPoints([]);
                      setIgnoredGroundSampleCount(0);
                      setCompetitionReferenceLat("");
                      setCompetitionReferenceLon("");
                      setCompetitionReferenceGroupId(null);
                      setShowCompetitionReferencePicker(false);
                      setTrackInfoEditJumpId(null);
                      setJumpLocationName("");
                      setJumpSuitName("");
                      setJumpNotes("");
                      setSaveJumpStatus("");
                      return;
                    }

                    setGpsFileName(file.name);

                    setTrackInfoEditJumpId(null);
                    setCompetitionReferenceLat("");
                    setCompetitionReferenceLon("");
                    setCompetitionReferenceGroupId(null);
                    setShowCompetitionReferencePicker(false);
                    setJumpLocationName("");
                    setJumpSuitName("");
                    setJumpNotes("");
                    setSaveJumpStatus("");

                    const csvText = await file.text();
                    setRawGpsCsv(csvText);

                    const parsedPoints = parseFlySightCsv(csvText);
                    const workingTrackPoints = trimTrackForAnalysis(parsedPoints);

                    setGpsTrackPoints(workingTrackPoints);
                    setIgnoredGroundSampleCount(
                      Math.max(0, parsedPoints.length - workingTrackPoints.length)
                    );
                    setHistoricalWinds([]);
                    setHistoricalWindStatus("");

                    const estimatedDzElevationM =
                      estimateDzElevationM(parsedPoints);

                    const dzElevationNumber =
                      estimatedDzElevationM ??
                      optionalNumberFromInput(dzElevationM) ??
                      0;

                    if (estimatedDzElevationM !== null) {
                      setDzElevationM(String(estimatedDzElevationM));
                    }

                    const validatedJump = getValidatedJumpTrack(
                      workingTrackPoints,
                      dzElevationNumber
                    );
                    const detectedJumpTrack = getDetectedJumpTrack(
                      workingTrackPoints
                    );
                    const exitPoint =
                      validatedJump.exitPoint ?? detectedJumpTrack.exitPoint;

                    if (
                      !exitPoint ||
                      exitPoint.timestampMs === null
                    ) {
                      setHistoricalWindStatus(
                        "Historical winds could not be loaded because no timestamped jump exit was detected."
                      );
                      return;
                    }

                    const trimmedTrackPoints = workingTrackPoints;
                    const landingPoint =
                      trimmedTrackPoints[trimmedTrackPoints.length - 1] ??
                      parsedPoints[parsedPoints.length - 1];

                    const matchingLocation =
                      landingPoint === undefined
                        ? null
                        : findMatchingSavedLocation(landingPoint);

                    if (matchingLocation !== null) {
                      setJumpLocationName(matchingLocation.locationName);
                      setSaveJumpStatus(
                        `Matched saved location: ${matchingLocation.locationName}.`
                      );
                    }
                    setHistoricalWindStatus("Loading historical winds...");

                    try {
                      const importedWinds = await fetchHistoricalWindProfile({
                        latitude: exitPoint.lat,
                        longitude: exitPoint.lon,
                        timestampMs: exitPoint.timestampMs,
                        dzElevationM: dzElevationNumber,
                      });

                      setHistoricalWinds(importedWinds);
                      setHistoricalWindStatus(
                        `Loaded ${importedWinds.length} historical wind levels.`
                      );
                    } catch (error) {
                      const message =
                        error instanceof Error
                          ? error.message
                          : "Unknown historical wind error.";

                      setHistoricalWindStatus(`Could not load historical winds: ${message}`);
                    }
                  }}          />
              </label>

              {historicalWindStatus && (
                <p className="subtitle">{historicalWindStatus}</p>
              )}

              {gpsFileName && (
                <p className="subtitle">
                  Selected file: <strong>{gpsFileName}</strong>
                </p>
              )}

              {ignoredGroundSampleCount > 0 && (
                <p className="subtitle" role="status">
                  Ignored {ignoredGroundSampleCount.toLocaleString()} stationary
                  ground samples before takeoff or after landing (
                  {formatNumber(
                    ignoredGroundSampleCount * GPS_SAMPLE_PERIOD_SECONDS / 60,
                    1
                  )} minutes).
                </p>
              )}
            </section>
            
{supabaseSession ? (
  <section ref={logbookSectionRef} className="card logbook-card">
    <h2>My Logbook</h2>

    {logbookStatus && (
      <p className="subtitle">{logbookStatus}</p>
    )}

    <label className="logbook-search-field">
      Search logbook
      <input
        type="search"
        value={logbookSearchQuery}
        placeholder="enter: location or over____ secs/kph/m"
        onChange={(event) => {
          const nextSearchQuery = event.target.value;
          setLogbookSearchQuery(nextSearchQuery);

          if (nextSearchQuery.trim() && logbookTaskFilter !== "all") {
            setLogbookTaskFilter("all");
          }
        }}
      />
    </label>

    <div className="logbook-filter-controls">
      <button
        type="button"
        className={logbookTaskFilter === "recent" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("recent")}
      >
        Recent
      </button>

      <button
        type="button"
        className={logbookTaskFilter === "all" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("all")}
      >
        All
      </button>

      <button
        type="button"
        className={logbookTaskFilter === "speed" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("speed")}
      >
        Speed
      </button>

      <button
        type="button"
        className={logbookTaskFilter === "time" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("time")}
      >
        Time
      </button>

      <button
        type="button"
        className={logbookTaskFilter === "distance" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("distance")}
      >
        Distance
      </button>

      <button
        type="button"
        className={logbookTaskFilter === "non-comp" ? "active" : ""}
        onClick={() => setLogbookTaskFilter("non-comp")}
      >
        Non-comp
      </button>
    </div>

    <div className="logbook-table-wrap">
      <table className="logbook-table">
        <thead>
          <tr>
            <th>Date / Time</th>
            <th>Task</th>
            <th>Location</th>
            <th>Suit</th>
            <th>Time</th>
            <th>Distance</th>
            <th>Speed</th>
            <th>Notes</th>
          </tr>
        </thead>

        <tbody>
          {savedJumps.length > 0 && visibleSavedJumps.length === 0 && (
            <tr>
              <td colSpan={8} className="logbook-empty-cell">
                No jumps match that search.
              </td>
            </tr>
          )}

          {visibleSavedJumps.map((jump) => (
            <tr
              key={jump.id}
              className={[
                editingJumpId === jump.id ? "" : "logbook-row-clickable",
                showCompareSelector &&
                selectedCompareTrackIds.includes("saved-" + jump.id)
                  ? "logbook-row-compare-selected"
                  : "",
                getPinnedBestJumpIds(visibleSavedJumps).has(jump.id)
                  ? "logbook-row-pinned"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              tabIndex={editingJumpId === jump.id ? undefined : 0}
              onClick={(event) => {
                if (editingJumpId === jump.id) {
                  return;
                }

                event.stopPropagation();
                setLogbookActionMenu({
                  jumpId: jump.id,
                  left: Math.min(
                    Math.max(event.clientX, 130),
                    window.innerWidth - 130
                  ),
                  top: Math.min(event.clientY + 10, window.innerHeight - 128),
                });
              }}
              onKeyDown={(event) => {
                if (
                  editingJumpId !== jump.id &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  const rowRect = event.currentTarget.getBoundingClientRect();
                  setLogbookActionMenu({
                    jumpId: jump.id,
                    left: Math.min(
                      Math.max(rowRect.left + 130, 130),
                      window.innerWidth - 130
                    ),
                    top: Math.min(rowRect.bottom + 8, window.innerHeight - 128),
                  });
                }
              }}
            >
              <td>
                {formatLogbookDateTime(jump.jump_date)}
              </td>

              <td>
                {formatLogbookTrackType(jump.task_type)}
              </td>

              <td>
                {editingJumpId === jump.id ? (
                  <input
                    type="text"
                    value={editLocationName}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setEditLocationName(event.target.value)
                    }
                  />
                ) : (
                  jump.location_name || "Not entered"
                )}
              </td>

              <td>
                {editingJumpId === jump.id ? (
                  <input
                    type="text"
                    value={editSuitName}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setEditSuitName(event.target.value)
                    }
                  />
                ) : (
                  jump.suit_name || "Not entered"
                )}
              </td>

              <td>
                {formatNumber(jump.window_time_s, 2)} sec
              </td>

              <td>
                {formatNumber(jump.window_distance_m, 0)} m
              </td>

              <td>
                {formatNumber(jump.window_speed_kmh, 1)} km/h
              </td>

              <td className="logbook-notes-cell">
                {editingJumpId === jump.id ? (
                  <textarea
                    value={editNotes}
                    placeholder="Notes"
                    rows={3}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setEditNotes(event.target.value)
                    }
                  />
                ) : (
                  <span className="logbook-notes-preview">
                    {jump.notes || "Tap row for actions"}
                  </span>
                )}
                {editingJumpId === jump.id && (
                  <div
                    className="logbook-table-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={saveEditedJump}
                    >
                      Save
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditingJumpId(null)}
                    >
                      Cancel
                    </button>

                    <button
                      type="button"
                      className="delete-jump-button"
                      onClick={() => deleteSavedJump(jump.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {logbookActionMenu &&
      (() => {
        const menuJump = visibleSavedJumps.find(
          (jump) => jump.id === logbookActionMenu.jumpId
        );

        if (!menuJump) {
          return null;
        }

        return (
          <div
            className="logbook-action-menu"
            style={{
              left: logbookActionMenu.left,
              top: logbookActionMenu.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                void openSavedJump(menuJump);
                setLogbookActionMenu(null);
              }}
            >
              Open
            </button>

            <button
              type="button"
              className={
                selectedCompareTrackIds.includes("saved-" + menuJump.id)
                  ? "compare-row-button active"
                  : "compare-row-button"
              }
              disabled={!menuJump.raw_csv}
              onClick={() => {
                openCompareTracksSelector();
                toggleSavedJumpCompare(menuJump);
                setLogbookActionMenu(null);
              }}
            >
              {selectedCompareTrackIds.includes("saved-" + menuJump.id)
                ? "Selected"
                : "Compare"}
            </button>

            <button
              type="button"
              onClick={() => {
                void editSavedJumpInTrackInfo(menuJump);
                setLogbookActionMenu(null);
              }}
            >
              Edit
            </button>

            <button
              type="button"
              className="delete-jump-button"
              onClick={() => {
                void deleteSavedJump(menuJump.id);
                setLogbookActionMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        );
      })()}

  </section>
) : (
  <section className="card logbook-card logbook-placeholder-card">
    <h2>My Logbook</h2>
    <p className="subtitle">
      Log in or sign up to access the logbook function.
    </p>
    <button
      type="button"
      className="logbook-account-toggle"
      onClick={() => setShowLogbookLogin(true)}
    >
      {supabaseSession ? "Logbook account" : "Sign in / Create account"}
    </button>
  </section>
)}

<section className="card save-jump-card">
  <h2>Track Info</h2>

  {trackInfoEditJumpId && (
    <p className="subtitle">
      Editing saved jump. Choose a save type below to update this logbook entry.
    </p>
  )}

  <label>
    Location
    <input
      type="text"
      value={jumpLocationName}
      placeholder="Dropzone or event"
      onChange={(event) => setJumpLocationName(event.target.value)}
    />
  </label>

  <label>
    Suit
    <input
      type="text"
      value={jumpSuitName}
      placeholder="Wingsuit model"
      onChange={(event) => setJumpSuitName(event.target.value)}
    />
  </label>

  <label>
    Notes
    <textarea
      value={jumpNotes}
      placeholder="Jump notes"
      rows={3}
      onChange={(event) => setJumpNotes(event.target.value)}
    />
  </label>

  <p className="subtitle">
    Use Non-comp for any FlySight track that is not a competition run. It saves
    the full original CSV without requiring a detected exit or complete scoring
    window.
  </p>

  <div className="landing-actions track-info-actions">
    <button
      type="button"
      onClick={() => handleSaveJump("speed")}
      disabled={
        saveJumpBusy ||
        !supabaseSession ||
        !rawGpsCsv
      }
    >
      {saveJumpBusy ? "Saving..." : "Save as speed"}
    </button>

    <button
      type="button"
      onClick={() => handleSaveJump("time")}
      disabled={
        saveJumpBusy ||
        !supabaseSession ||
        !rawGpsCsv
      }
    >
      {saveJumpBusy ? "Saving..." : "Save as time"}
    </button>

    <button
      type="button"
      onClick={() => handleSaveJump("distance")}
      disabled={
        saveJumpBusy ||
        !supabaseSession ||
        !rawGpsCsv
      }
    >
      {saveJumpBusy ? "Saving..." : "Save as distance"}
    </button>

    <button
      type="button"
      onClick={() => handleSaveJump("non-comp")}
      disabled={
        saveJumpBusy ||
        !supabaseSession ||
        !rawGpsCsv ||
        gpsTrackPoints.length === 0
      }
      title="Save the full FlySight track without requiring a competition scoring window"
    >
      {saveJumpBusy ? "Saving..." : "Save as non-comp"}
    </button>

    <button
      type="button"
      className="compare-tracks-button"
      onClick={openCompareTracksSelector}
      disabled={!rawGpsCsv && !supabaseSession}
    >
      Compare tracks
    </button>
  </div>

  {showCompareSelector && (
    <div className="compare-selector">
      <div className="compare-selector-heading">
        <strong>Compare tracks</strong>

        <div className="compare-selector-actions">
          <button
            type="button"
            onClick={() => {
              setSelectedCompareTrackIds([]);
              setCompareOptions([]);
              setCompareStatus("Tracks cleared.");
            }}
            disabled={
              selectedCompareTrackIds.length === 0 && compareOptions.length === 0
            }
          >
            Clear tracks
          </button>

          <button
            type="button"
            onClick={() => setShowCompareSelector(false)}
            aria-label="Close compare tracks selector"
          >
            Close
          </button>
        </div>
      </div>

      {compareStatus && (
        <p className="subtitle compare-selector-status">{compareStatus}</p>
      )}

      <div className="compare-track-options">
        {compareOptions.map((option, index) => {
          const selectedIndex = selectedCompareTrackIds.indexOf(option.id);
          const selectedColor =
            selectedIndex === -1
              ? compareTrackColors[index % compareTrackColors.length]
              : compareTrackColors[selectedIndex];

          return (
            <label key={option.id} className="compare-track-option">
              <input
                type="checkbox"
                checked={selectedIndex !== -1}
                onChange={() => toggleCompareTrack(option)}
              />
              <span
                className="compare-color-swatch"
                style={{ background: selectedColor }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  )}

  {saveJumpStatus && (
    <p className="subtitle">{saveJumpStatus}</p>
  )}
</section>

{gpsTrackPoints.length === 0 && (
  <section className="card track-summary-card">
    <h2>Track Summary</h2>

    <p className="subtitle">
      Window uses {2500 + windowOffsetM} m to{" "}
      {1500 + windowOffsetM} m.
    </p>

    <div className="metric-section">
      <h3>Main Scores</h3>

      <div className="main-score-columns">
        <div className="main-score-column">
          <div><span>Jump Time: </span><strong>&mdash;</strong></div>
          <div><span>Exit Location: </span><strong>&mdash;</strong></div>
          <div><span>Exit Altitude: </span><strong>&mdash;</strong></div>
          <div><span>Time: </span><strong>&mdash;</strong></div>
          <div><span>Distance: </span><strong>&mdash;</strong></div>
          <div><span>Speed: </span><strong>&mdash;</strong></div>
        </div>

        <div className="main-score-column">
          <div><span>Peak Dive Angle: </span><strong>&mdash;</strong></div>
          <div><span>Peak Vertical Speed: </span><strong>&mdash;</strong></div>
          <div><span>Peak Total Speed: </span><strong>&mdash;</strong></div>
          <div><span>Peak Horizontal Speed: </span><strong>&mdash;</strong></div>
          <div><span>Entry Glide Ratio: </span><strong>&mdash;</strong></div>
          <div><span>Exit Glide Ratio: </span><strong>&mdash;</strong></div>
        </div>
      </div>
    </div>
  </section>
)}
{gpsTrackPoints.length === 0 && (
  <section className="card graph-placeholder-card">
    <h2>Interactive Jump Graph</h2>

    <p className="subtitle">
      Import a FlySight CSV to display the jump graph.
    </p>

    <div className="graph-placeholder">
      No track loaded
    </div>
  </section>
)}

{gpsTrackPoints.length > 0 &&
  (() => {
    const dzElevationNumber = numberFromInput(
      dzElevationM,
      0
    );

    const validatedJump = getValidatedJumpTrack(
      gpsTrackPoints,
      dzElevationNumber
    );
    const detectedJumpTrack = getDetectedJumpTrack(gpsTrackPoints);

    if (!validatedJump.isValidJump) {
      return (
        <NonCompetitionTrackReview
          points={
            detectedJumpTrack.isExitDetected
              ? detectedJumpTrack.jumpPoints
              : gpsTrackPoints
          }
          dzElevationM={dzElevationNumber}
          reason={
            detectedJumpTrack.isExitDetected
              ? "A competition-valid exit could not be confirmed."
              : "A jump exit could not be detected."
          }
          startsAtDetectedExit={detectedJumpTrack.isExitDetected}
          winds={historicalWinds}
          scoreMode={jumpScoreMode}
          onScoreModeChange={setJumpScoreMode}
        />
      );
    }

    const jumpTrackPoints =
      validatedJump.jumpPoints.map((point) => ({
        ...point,
        altitudeM:
          point.altitudeM - dzElevationNumber,
      }));

    const exitPoint = validatedJump.exitPoint;

    const scoringWindowResult =
      getScoringWindowResult(
        jumpTrackPoints,
        windowOffsetM
      );

    if (!scoringWindowResult) {
      return (
        <NonCompetitionTrackReview
          points={
            detectedJumpTrack.isExitDetected
              ? detectedJumpTrack.jumpPoints
              : validatedJump.jumpPoints
          }
          dzElevationM={dzElevationNumber}
          reason="A complete competition scoring window could not be detected."
          startsAtDetectedExit
          winds={historicalWinds}
          scoreMode={jumpScoreMode}
          onScoreModeChange={setJumpScoreMode}
        />
      );
    }

    const windowTrackPoints = getWindowTrackPoints(
      jumpTrackPoints,
      windowOffsetM
    );

    const preWindowDivePoints = jumpTrackPoints.slice(
      0,
      scoringWindowResult.startIndex + 1
    );

    const rawWindowDistanceM = scoringWindowResult.distanceM;
    const timeInWindowSeconds = scoringWindowResult.timeSeconds;

    const correctedWindowDistanceM = getWindCorrectedWindowDistanceM(
      windowTrackPoints,
      historicalWinds
    );

    const usingCorrectedScores =
      jumpScoreMode === "corrected" && historicalWinds.length > 0;
    const assessorUsesCalculatedAirspeed = historicalWinds.length > 0;

    const windowDistanceM = usingCorrectedScores
      ? correctedWindowDistanceM
      : rawWindowDistanceM;
    const assessorWindowDistanceM = assessorUsesCalculatedAirspeed
      ? correctedWindowDistanceM
      : rawWindowDistanceM;

    const averageHorizontalSpeedKmh =
      timeInWindowSeconds > 0
        ? metresPerSecondToKmh(windowDistanceM / timeInWindowSeconds)
        : null;
    const assessorAverageHorizontalSpeedKmh =
      timeInWindowSeconds > 0
        ? metresPerSecondToKmh(
            assessorWindowDistanceM / timeInWindowSeconds,
          )
        : null;
    const last800mPoints =
      getLast800mWindowPoints(jumpTrackPoints);

    const rawLast800mDistanceM =
      getTrackDistanceM(last800mPoints);

    const correctedLast800mDistanceM = getWindCorrectedWindowDistanceM(
      last800mPoints,
      historicalWinds
    );

    const last800mDistanceM = usingCorrectedScores
      ? correctedLast800mDistanceM
      : rawLast800mDistanceM;
    const assessorLast800mDistanceM = assessorUsesCalculatedAirspeed
      ? correctedLast800mDistanceM
      : rawLast800mDistanceM;

    const last800mTimeSeconds =
      last800mPoints.length > 1
        ? (last800mPoints.length - 1) *
          GPS_SAMPLE_PERIOD_SECONDS
        : 0;

    const last800mAverageHorizontalSpeedKmh =
      last800mTimeSeconds > 0
        ? metresPerSecondToKmh(
            last800mDistanceM / last800mTimeSeconds
          )
        : null;
    const assessorLast800mAverageHorizontalSpeedKmh =
      last800mTimeSeconds > 0
        ? metresPerSecondToKmh(
            assessorLast800mDistanceM / last800mTimeSeconds,
          )
        : null;

    const last800mAltitudeLossM =
      last800mPoints.length > 1
        ? last800mPoints[0].altitudeM -
          last800mPoints[last800mPoints.length - 1].altitudeM
        : 0;

    const last800mAverageVerticalSpeedKmh =
      last800mTimeSeconds > 0
        ? metresPerSecondToKmh(
            last800mAltitudeLossM / last800mTimeSeconds
          )
        : null;

    const last800mAverageGlideRatio =
      last800mAltitudeLossM > 0
        ? last800mDistanceM / last800mAltitudeLossM
        : null;
    const assessorLast800mAverageGlideRatio =
      last800mAltitudeLossM > 0
        ? assessorLast800mDistanceM / last800mAltitudeLossM
        : null;

    const isSpeedRun =
      timeInWindowSeconds > 0 &&
      timeInWindowSeconds <= 40;

    const windowEntryPoint = windowTrackPoints[0] ?? null;
    const windowExitPoint =
      windowTrackPoints[windowTrackPoints.length - 1] ?? null;

    const windowEntryGlideRatio =
      windowEntryPoint === null
        ? null
        : getDisplayGlideRatio(
            windowEntryPoint,
            historicalWinds,
            usingCorrectedScores
          );

    const windowExitGlideRatio =
      windowExitPoint === null
        ? null
        : getDisplayGlideRatio(
            windowExitPoint,
            historicalWinds,
            usingCorrectedScores
          );

    const peakSpeedPoints = isSpeedRun
      ? windowTrackPoints
      : preWindowDivePoints;

    const peakDiveHorizontalSpeedKmh =
      peakSpeedPoints.length > 0
        ? metresPerSecondToKmh(
            Math.max(
              ...peakSpeedPoints.map((point) =>
                getDisplayHorizontalSpeedMps(
                  point,
                  historicalWinds,
                  usingCorrectedScores
                )
              )
            )
          )
        : null;

    const peakDiveVerticalSpeedKmh =
      preWindowDivePoints.length > 0
        ? metresPerSecondToKmh(
            Math.max(
              ...preWindowDivePoints.map(
                (point) => point.verticalSpeedMps
              )
            )
          )
        : null;

    const peakDiveTotalSpeedKmh =
      peakSpeedPoints.length > 0
        ? metresPerSecondToKmh(
            Math.max(
              ...peakSpeedPoints.map((point) =>
                getDisplayTotalSpeedMps(
                  point,
                  historicalWinds,
                  usingCorrectedScores
                )
              )
            )
          )
        : null;

    const peakDiveAngleDeg =
      preWindowDivePoints.length > 0
        ? Math.max(
            ...preWindowDivePoints.map(getPointDiveAngleDeg)
          )
        : null;
    const assessorPeakDiveTotalSpeedKmh =
      peakSpeedPoints.length > 0
        ? metresPerSecondToKmh(
            Math.max(
              ...peakSpeedPoints.map((point) =>
                getDisplayTotalSpeedMps(
                  point,
                  historicalWinds,
                  assessorUsesCalculatedAirspeed,
                ),
              ),
            ),
          )
        : null;
    const assessorPeakDiveAngleDeg =
      preWindowDivePoints.length > 0
        ? Math.max(
            ...preWindowDivePoints.map((point) => {
              const horizontalSpeedMps = getDisplayHorizontalSpeedMps(
                point,
                historicalWinds,
                assessorUsesCalculatedAirspeed,
              );

              return (
                Math.atan2(
                  Math.max(point.verticalSpeedMps, 0),
                  Math.max(horizontalSpeedMps, 0.001),
                ) *
                (180 / Math.PI)
              );
            }),
          )
        : null;

    const top100mFlare = getTop100mFlareResult(
      jumpTrackPoints,
      timeInWindowSeconds
    );

    const top100mFlarePoints =
      top100mFlare === null
        ? []
        : jumpTrackPoints.slice(
            top100mFlare.startIndex,
            top100mFlare.endIndex + 1
          );

    const top100mFlareDistanceM =
      top100mFlare === null
        ? null
        : usingCorrectedScores
          ? getWindCorrectedWindowDistanceM(
              top100mFlarePoints,
              historicalWinds
            )
          : top100mFlare.distanceM;

    const fullJumpPoints = trimTrackAfterLanding(jumpTrackPoints);

    const scoringWindowEndAltitudeM =
      jumpTrackPoints[scoringWindowResult.endIndex].altitudeM;

    const compGraphEndAltitudeM =
      scoringWindowEndAltitudeM - 50;

    const compGraphEndOffset = fullJumpPoints
      .slice(scoringWindowResult.endIndex)
      .findIndex(
        (point) => point.altitudeM <= compGraphEndAltitudeM
      );

    const compGraphEndIndex =
      compGraphEndOffset === -1
        ? scoringWindowResult.endIndex
        : scoringWindowResult.endIndex + compGraphEndOffset;

    const maximumExitAltitudeIndex = fullJumpPoints.reduce(
      (highestIndex, point, index, array) =>
        point.altitudeM > array[highestIndex].altitudeM
          ? index
          : highestIndex,
      0
    );

    const competitionRunPoints = fullJumpPoints.slice(
      maximumExitAltitudeIndex,
      compGraphEndIndex + 1
    );

    const displayedGraphPoints =
      graphView === "comp"
        ? competitionRunPoints
        : fullJumpPoints;

    const pointA = getValidationStartPoint(jumpTrackPoints);
    const pointBLat = optionalNumberFromInput(competitionReferenceLat);
    const pointBLon = optionalNumberFromInput(competitionReferenceLon);
    const pointB =
      pointBLat !== null && pointBLon !== null
        ? { lat: pointBLat, lon: pointBLon }
        : null;
    const selectedCompetitionReferencePointsForMap = (() => {
      if (selectedCompetitionReferenceGroup === null || pointB === null) {
        return NO_SAVED_REFERENCE_POINTS;
      }

      const selectedPoint = selectedCompetitionReferenceGroup.points.find(
        (point) =>
          Math.abs(point.lat - pointB.lat) < 0.000001 &&
          Math.abs(point.lon - pointB.lon) < 0.000001,
      );

      return selectedPoint ? [selectedPoint] : NO_SAVED_REFERENCE_POINTS;
    })();
    const laneHeadingDeg =
      pointA !== null && pointB !== null
        ? String(
            bearingBetweenPointsDeg(
              pointA.lat,
              pointA.lon,
              pointB.lat,
              pointB.lon
            )
          )
        : "";
    const savedReferenceGroupMatches =
      pointA === null
        ? []
        : savedReferencePointStore.groups
            .flatMap((group) => {
              if (group.points.length === 0) {
                return [];
              }

              const nearestDistanceM = Math.min(
                ...group.points.map((point) =>
                  distanceBetweenLatLonM(pointA, point),
                ),
              );

              return nearestDistanceM <=
                ANALYZER_REFERENCE_GROUP_MATCH_RADIUS_M
                ? [{ group, nearestDistanceM }]
                : [];
            })
            .sort(
              (first, second) =>
                first.nearestDistanceM - second.nearestDistanceM,
            );
    const getSmoothedBoundaryGlideRatio = (pointIndex: number) => {
      const radiusSamples = Math.round(1 / GPS_SAMPLE_PERIOD_SECONDS);
      const glideRatios = jumpTrackPoints
        .slice(
          Math.max(0, pointIndex - radiusSamples),
          Math.min(jumpTrackPoints.length, pointIndex + radiusSamples + 1),
        )
        .map((point) =>
          getDisplayGlideRatio(
            point,
            historicalWinds,
            assessorUsesCalculatedAirspeed,
          ),
        )
        .filter(
          (glideRatio): glideRatio is number =>
            glideRatio !== null && Number.isFinite(glideRatio),
        );

      return glideRatios.length > 0
        ? glideRatios.reduce((total, glideRatio) => total + glideRatio, 0) /
            glideRatios.length
        : null;
    };
    const assessorEntryGlideRatio = getSmoothedBoundaryGlideRatio(
      scoringWindowResult.startIndex,
    );
    const assessorExitGlideRatio = getSmoothedBoundaryGlideRatio(
      scoringWindowResult.endIndex,
    );
    const rawWindowPathDistanceM = getTrackDistanceM(windowTrackPoints);
    const lineEfficiencyPercent =
      rawWindowPathDistanceM > 0
        ? (rawWindowDistanceM / rawWindowPathDistanceM) * 100
        : null;
    const parsedAssessorTailwindKts =
      assessorTailwindKts.trim() === ""
        ? null
        : Number(assessorTailwindKts);
    const assessorTailwindNumber =
      parsedAssessorTailwindKts !== null &&
      Number.isFinite(parsedAssessorTailwindKts)
        ? parsedAssessorTailwindKts
        : null;
    const flarePeakIndex = (() => {
      if (top100mFlare === null) {
        return null;
      }

      let peakIndex = top100mFlare.startIndex;

      for (
        let pointIndex = top100mFlare.startIndex;
        pointIndex <= top100mFlare.endIndex;
        pointIndex += 1
      ) {
        if (
          jumpTrackPoints[pointIndex].altitudeM >
          jumpTrackPoints[peakIndex].altitudeM
        ) {
          peakIndex = pointIndex;
        }
      }

      return peakIndex;
    })();
    const postFlareStartIndex = (() => {
      if (top100mFlare !== null) {
        // The first 100 m contains the deliberate flare conversion. Judge
        // energy management only once that phase and a short settling period
        // are complete, otherwise a good flare looks like an oscillation.
        return Math.min(
          top100mFlare.endIndex + Math.round(1 / GPS_SAMPLE_PERIOD_SECONDS),
          scoringWindowResult.endIndex,
        );
      }

      const settledWindowIndex = jumpTrackPoints.findIndex(
        (point, pointIndex) =>
          pointIndex >= scoringWindowResult.startIndex &&
          point.altitudeM <= 2300,
      );

      return settledWindowIndex === -1
        ? scoringWindowResult.startIndex
        : settledWindowIndex;
    })();
    const flightTransitionStartIndex = (() => {
      if (flarePeakIndex === null) {
        return null;
      }

      const peakFlareAltitudeM = jumpTrackPoints[flarePeakIndex].altitudeM;
      const verticalConfirmationSamples = Math.round(
        1 / GPS_SAMPLE_PERIOD_SECONDS,
      );

      for (
        let pointIndex = flarePeakIndex;
        pointIndex < postFlareStartIndex;
        pointIndex += 1
      ) {
        const confirmationPoints = jumpTrackPoints.slice(
          pointIndex,
          pointIndex + verticalConfirmationSamples,
        );
        const averageVerticalSpeedMps = averageFiniteNumbers(
          confirmationPoints.map((point) => point.verticalSpeedMps),
        );
        const hasLeftFlareApex =
          jumpTrackPoints[pointIndex].altitudeM <= peakFlareAltitudeM - 10 &&
          averageVerticalSpeedMps !== null &&
          averageVerticalSpeedMps >= 5;

        if (hasLeftFlareApex) {
          return pointIndex;
        }
      }

      return Math.min(
        flarePeakIndex + Math.round(2 / GPS_SAMPLE_PERIOD_SECONDS),
        postFlareStartIndex,
      );
    })();
    const flightTransitionPoints =
      flightTransitionStartIndex === null
        ? []
        : jumpTrackPoints.slice(
            flightTransitionStartIndex,
            postFlareStartIndex + 1,
          );
    const postFlareEnergyPoints = jumpTrackPoints.slice(
      postFlareStartIndex,
      scoringWindowResult.endIndex + 1,
    );
    const energyBlockSampleCount = Math.max(
      1,
      Math.round(1 / GPS_SAMPLE_PERIOD_SECONDS),
    );
    const getFlightPhaseSamples = (phasePoints: GpsTrackPoint[]) => {
      const samples: EnergyManagementSample[] = [];

      for (
        let blockStartIndex = 0;
        blockStartIndex < phasePoints.length;
        blockStartIndex += energyBlockSampleCount
      ) {
        const blockPoints = phasePoints.slice(
          blockStartIndex,
          blockStartIndex + energyBlockSampleCount,
        );

        if (blockPoints.length < Math.ceil(energyBlockSampleCount / 2)) {
          continue;
        }

        const totalSpeedKmh = averageFiniteNumbers(
          blockPoints.map((point) =>
            metresPerSecondToKmh(
              getDisplayTotalSpeedMps(
                point,
                historicalWinds,
                assessorUsesCalculatedAirspeed,
              ),
            ),
          ),
        );
        const diveAngleDeg = averageFiniteNumbers(
          blockPoints.map((point) => {
            const horizontalSpeedMps = getDisplayHorizontalSpeedMps(
              point,
              historicalWinds,
              assessorUsesCalculatedAirspeed,
            );

            return (
              Math.atan2(
                Math.max(point.verticalSpeedMps, 0),
                Math.max(horizontalSpeedMps, 0.001),
              ) *
              (180 / Math.PI)
            );
          }),
        );
        const glideRatio = averageFiniteNumbers(
          blockPoints.map((point) =>
            getDisplayGlideRatio(
              point,
              historicalWinds,
              assessorUsesCalculatedAirspeed,
            ),
          ),
        );

        if (totalSpeedKmh !== null && diveAngleDeg !== null) {
          samples.push({
            totalSpeedKmh,
            diveAngleDeg,
            glideRatio,
          });
        }
      }

      return samples;
    };

    const getTargetAdherenceSamples = (phasePoints: GpsTrackPoint[]) => {
      const samples: TargetAdherenceSample[] = [];
      const zeroWindSpeedTargetKmh = numberFromInput(
        assessorTaskMode === "time"
          ? editableFindNumbers.timeSpeedKph
          : editableFindNumbers.distanceSpeedKph,
        0,
      );
      const speedStartGlideRatio = numberFromInput(
        editableFindNumbers.speedStartGR,
        0,
      );
      const speedEndGlideRatio = numberFromInput(
        editableFindNumbers.speedEndGR,
        0,
      );

      for (
        let blockStartIndex = 0;
        blockStartIndex < phasePoints.length;
        blockStartIndex += energyBlockSampleCount
      ) {
        const blockPoints = phasePoints.slice(
          blockStartIndex,
          blockStartIndex + energyBlockSampleCount,
        );

        if (blockPoints.length < Math.ceil(energyBlockSampleCount / 2)) {
          continue;
        }

        const averageAltitudeM = averageFiniteNumbers(
          blockPoints.map((point) => point.altitudeM),
        );

        if (averageAltitudeM === null) {
          continue;
        }

        if (assessorTaskMode === "speed") {
          const actualGlideRatio = averageFiniteNumbers(
            blockPoints.map((point) =>
              getDisplayGlideRatio(
                point,
                historicalWinds,
                assessorUsesCalculatedAirspeed,
              ),
            ),
          );

          if (
            actualGlideRatio !== null &&
            speedStartGlideRatio > 0 &&
            speedEndGlideRatio > speedStartGlideRatio
          ) {
            samples.push({
              actualValue: actualGlideRatio,
              targetValue: baseGRAtAltitude(
                averageAltitudeM,
                speedStartGlideRatio,
                speedEndGlideRatio,
              ),
            });
          }

          continue;
        }

        const actualTotalSpeedKmh = averageFiniteNumbers(
          blockPoints.map((point) =>
            metresPerSecondToKmh(
              getDisplayTotalSpeedMps(
                point,
                historicalWinds,
                assessorUsesCalculatedAirspeed,
              ),
            ),
          ),
        );

        if (actualTotalSpeedKmh !== null && zeroWindSpeedTargetKmh > 0) {
          samples.push({
            actualValue: actualTotalSpeedKmh,
            targetValue:
              zeroWindSpeedTargetKmh -
              delayedPerformanceDropKph(averageAltitudeM),
          });
        }
      }

      return samples;
    };

    const flightTransitionSamples = getFlightPhaseSamples(
      flightTransitionPoints,
    );
    const energyManagementSamples = getFlightPhaseSamples(
      postFlareEnergyPoints,
    );
    const targetAdherenceSamples = getTargetAdherenceSamples(
      assessorTaskMode === "speed"
        ? windowTrackPoints
        : postFlareEnergyPoints,
    );
    const flightTransitionDurationSeconds =
      Math.max(0, flightTransitionPoints.length - 1) *
      GPS_SAMPLE_PERIOD_SECONDS;
    const postFlareEnergyDurationSeconds =
      Math.max(0, postFlareEnergyPoints.length - 1) *
      GPS_SAMPLE_PERIOD_SECONDS;
    const flightTransition =
      assessorTaskMode === "speed" || flightTransitionStartIndex === null
        ? null
        : analyzeFlightTransition(
            flightTransitionSamples,
            flightTransitionDurationSeconds,
          );
    const energyManagement =
      assessorTaskMode === "speed"
        ? null
        : analyzeEnergyManagement(
            energyManagementSamples,
            postFlareEnergyDurationSeconds,
          );
    const targetAdherence = analyzeTargetAdherence(
      assessorTaskMode,
      targetAdherenceSamples,
    );
    const trackAssessment = buildTrackAssessment({
      task: assessorTaskMode,
      timeSeconds: timeInWindowSeconds,
      distanceM: assessorWindowDistanceM,
      speedKmh: assessorAverageHorizontalSpeedKmh,
      peakDiveAngleDeg: assessorPeakDiveAngleDeg,
      peakVerticalSpeedKmh: peakDiveVerticalSpeedKmh,
      peakTotalSpeedKmh: assessorPeakDiveTotalSpeedKmh,
      entryGlideRatio: assessorEntryGlideRatio,
      exitGlideRatio: assessorExitGlideRatio,
      flareStartAltitudeM: top100mFlare?.startAltitudeM ?? null,
      flareAltitudeGainM: top100mFlare?.altitudeGainM ?? null,
      last800mHorizontalSpeedKmh:
        assessorLast800mAverageHorizontalSpeedKmh,
      last800mGlideRatio: assessorLast800mAverageGlideRatio,
      lineEfficiencyPercent,
      tailwindKts: assessorTailwindNumber,
      usesCalculatedAirspeed: assessorUsesCalculatedAirspeed,
      targetAdherence,
      flightTransition,
      energyManagement,
    });
    const validationStartIndex = Math.min(
      Math.round(9 / GPS_SAMPLE_PERIOD_SECONDS),
      jumpTrackPoints.length - 1,
    );
    const laneEvaluationPoints =
      scoringWindowResult.endIndex >= validationStartIndex
        ? jumpTrackPoints.slice(
            validationStartIndex,
            scoringWindowResult.endIndex + 1,
          )
        : [];
    const lanePenaltyEstimate =
      pointA !== null && pointB !== null
        ? estimateLanePenalty(laneEvaluationPoints, pointA, pointB)
        : null;

    return (
    <>
      <section className="card track-summary-card">
        <h2>Jump Metrics</h2>

        <p className="subtitle">
          Window uses {2500 + windowOffsetM} m to{" "}
          {1500 + windowOffsetM} m.
        </p>

        <div className="window-adjust-controls">
          <button
            type="button"
            onClick={() =>
              setWindowOffsetM((current) => current - 10)
            }
          >
            -10 m
          </button>

          <button
            type="button"
            onClick={() => setWindowOffsetM(0)}
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() =>
              setWindowOffsetM((current) => current + 10)
            }
          >
            +10 m
          </button>
        </div>

        <div className="metric-section">
          <h3>Main Scores</h3>

          <label className="score-mode-switch">
            <span className={jumpScoreMode === "raw" ? "active" : ""}>Raw</span>

            <input
              type="checkbox"
              checked={jumpScoreMode === "corrected"}
              onChange={(event) =>
                setJumpScoreMode(event.target.checked ? "corrected" : "raw")
              }
              disabled={historicalWinds.length === 0}
            />

            <span className="score-mode-track">
              <span className="score-mode-knob" />
            </span>

            <span className={jumpScoreMode === "corrected" ? "active" : ""}>
              Corrected
            </span>
          </label>

          {jumpScoreMode === "corrected" && historicalWinds.length === 0 && (
            <p className="subtitle">
              Load historical winds before using corrected scores.
            </p>
          )}

          <div className="main-score-columns">
            <div className="main-score-column">
              <div>
                <span>Jump Time: </span>
                <strong>
                  {exitPoint?.timestampMs
                    ? new Date(
                        exitPoint.timestampMs
                      ).toLocaleString()
                    : "Timestamp not detected"}
                </strong>
              </div>

              <div>
                <span>Exit Location: </span>
                <strong>
                  {exitPoint
                    ? `${exitPoint.lat.toFixed(5)}, ${exitPoint.lon.toFixed(5)}`
                    : "Location not detected"}
                </strong>
              </div>

              <div>
                <span>Exit Altitude: </span>
                <strong>
                  {formatNumber(
                    exitPoint
                      ? exitPoint.altitudeM - dzElevationNumber
                      : null,
                    0
                  )}{" "}
                  m
                </strong>
              </div>

              <div>
                <span>Time: </span>
                <strong>
                  {formatNumber(timeInWindowSeconds, 3)} sec
                </strong>
              </div>

              <div>
                <span>{usingCorrectedScores ? "Corrected Distance: " : "Distance: "}</span>
                <strong>
                  {formatNumber(windowDistanceM, 2)} m
                </strong>
              </div>

              <div>
                <span>{usingCorrectedScores ? "Corrected Speed: " : "Speed: "}</span>
                <strong>
                  {formatNumber(
                    averageHorizontalSpeedKmh,
                    3
                  )}{" "}
                  km/h
                </strong>
              </div>
            </div>

            <div className="main-score-column">
              <div>
                <span>Peak Dive Angle: </span>
                <strong>
                  {formatNumber(peakDiveAngleDeg, 1)} deg
                </strong>
              </div>

              <div>
                <span>Peak Vert Speed: </span>
                <strong>
                  {formatNumber(
                    peakDiveVerticalSpeedKmh,
                    1
                  )}{" "}
                  km/h
                </strong>
              </div>

              <div>
                <span>Peak Total Speed: </span>
                <strong>
                  {formatNumber(
                    peakDiveTotalSpeedKmh,
                    1
                  )}{" "}
                  km/h
                </strong>
              </div>

              <div>
                <span>Peak Horizontal Speed: </span>
                <strong>
                  {formatNumber(
                    peakDiveHorizontalSpeedKmh,
                    1
                  )}{" "}
                  km/h
                </strong>
              </div>
            </div>
          </div>
        </div>

        {isSpeedRun ? (
          <div className="metric-section">
            <h3>Speed Run</h3>

            <div className="result-grid">
              <div>
                <span>Window Entry GR: </span>
                <strong>
                  {formatNumber(windowEntryGlideRatio, 2)}
                </strong>
              </div>

              <div>
                <span>Window Exit GR: </span>
                <strong>
                  {formatNumber(windowExitGlideRatio, 2)}
                </strong>
              </div>

              <div>
                <span>Peak Horizontal Speed: </span>
                <strong>
                  {formatNumber(
                    peakDiveHorizontalSpeedKmh,
                    1
                  )}{" "}
                  km/h
                </strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="comparison-metric-columns">
            {top100mFlare && (
              <div className="metric-section">
                <h3>Top 100 m Flare</h3>

                <div className="result-grid">
                  <div>
                    <span>Time: </span>
                    <strong>
                      {formatNumber(
                        top100mFlare.timeSeconds,
                        1
                      )}{" "}
                      sec
                    </strong>
                  </div>

                  <div>
                    <span>{usingCorrectedScores ? "Corrected Distance: " : "Distance: "}</span>
                    <strong>
                      {formatNumber(
                        top100mFlareDistanceM,
                        0
                      )}{" "}
                      m
                    </strong>
                  </div>

                  <div>
                    <span>Flare Start: </span>
                    <strong>
                      {formatNumber(
                        top100mFlare.startAltitudeM,
                        0
                      )}{" "}
                      m
                    </strong>
                  </div>

                  <div>
                    <span>Altitude Gain: </span>
                    <strong>
                      {formatNumber(
                        top100mFlare.altitudeGainM,
                        0
                      )}{" "}
                      m
                    </strong>
                  </div>
                </div>
              </div>
            )}

            <div className="metric-section">
              <h3>Last 800 m</h3>

              <div className="result-grid">
                <div>
                  <span>{usingCorrectedScores ? "Corrected Distance: " : "Distance: "}</span>
                  <strong>
                    {formatNumber(last800mDistanceM, 0)} m
                  </strong>
                </div>

                <div>
                  <span>Time: </span>
                  <strong>
                    {formatNumber(
                      last800mTimeSeconds,
                      1
                    )}{" "}
                    sec
                  </strong>
                </div>

                <div>
                  <span>{usingCorrectedScores ? "Corrected Avg. Horizontal Speed: " : "Avg. Horizontal Speed: "}</span>
                  <strong>
                    {formatNumber(
                      last800mAverageHorizontalSpeedKmh,
                      1
                    )}{" "}
                    km/h
                  </strong>
                </div>

                <div>
                  <span>Avg. Vertical Speed: </span>
                  <strong>
                    {formatNumber(
                      last800mAverageVerticalSpeedKmh,
                      1
                    )}{" "}
                    km/h
                  </strong>
                </div>

                <div>
                  <span>
                    {usingCorrectedScores
                      ? "Corrected Avg. Glide Ratio: "
                      : "Avg. Glide Ratio: "}
                  </span>
                  <strong>
                    {formatNumber(last800mAverageGlideRatio, 2)}
                  </strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {trackAssessorAccess === "allowed" && (
        <section className="card track-assessor-card">
          <div className="track-assessor-heading">
            <div>
              <p className="track-assessor-eyebrow">Private preview</p>
              <h2>Track Assessor</h2>
            </div>
            <span className="track-assessor-access-badge">Personal access</span>
          </div>

          <p className="subtitle">
            Experimental post-flight feedback calibrated to your current pilot
            and suit profile. Choose the task flown before reviewing the result.
          </p>

          <div className="track-assessor-controls">
            <fieldset>
              <legend>Task flown</legend>
              <div className="track-assessor-task-buttons">
                {(["speed", "time", "distance"] as TaskMode[]).map(
                  (assessmentTask) => (
                    <button
                      type="button"
                      className={
                        assessorTaskMode === assessmentTask ? "active" : ""
                      }
                      key={assessmentTask}
                      onClick={() => setAssessorTaskMode(assessmentTask)}
                    >
                      {assessmentTask[0].toUpperCase() + assessmentTask.slice(1)}
                    </button>
                  ),
                )}
              </div>
            </fieldset>

            {assessorTaskMode === "speed" &&
              !assessorUsesCalculatedAirspeed && (
              <label>
                Along-track tailwind (kt)
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={assessorTailwindKts}
                  placeholder="Optional"
                  onChange={(event) =>
                    setAssessorTailwindKts(event.target.value)
                  }
                />
              </label>
              )}
          </div>

          <div className="track-assessor-profile">
            <span>Reference profile</span>
            <strong>
              179 cm · 79.4 kg body · 90.7 kg exit · CR+ wingtips
            </strong>
          </div>

          <div className="track-assessor-profile">
            <span>Assessment basis</span>
            <strong>
              {assessorUsesCalculatedAirspeed
                ? "Zero-wind targets · calculated airspeed"
                : "Zero-wind targets · provisional ground speed"}
            </strong>
          </div>

          {!assessorUsesCalculatedAirspeed && (
            <p className="subtitle track-assessor-wind-note">
              Load the wind profile to replace the provisional ground-speed
              evaluation with calculated airspeed.
            </p>
          )}

          <div className="metric-section track-assessor-result">
            <h3>{trackAssessment.headline}</h3>
            <p>{trackAssessment.summary}</p>

            <div className="track-assessor-feedback-grid">
              <article>
                <h4>What went well</h4>
                {trackAssessment.strengths.length > 0 ? (
                  <ul>
                    {trackAssessment.strengths.map((strength) => (
                      <li key={strength}>{strength}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    More labelled examples are needed before making a confident
                    positive comparison for this phase.
                  </p>
                )}
              </article>

              <article>
                <h4>Biggest opportunity</h4>
                <p>{trackAssessment.improvement}</p>
              </article>

              {trackAssessment.targetAdherence !== null && (
                <article className="track-assessor-energy-card">
                  <div className="track-assessor-energy-heading">
                    <h4>Target adherence</h4>
                    <span
                      className={`energy-rating energy-rating-${trackAssessment.targetAdherence.rating}`}
                    >
                      {trackAssessment.targetAdherence.label}
                    </span>
                  </div>
                  <p>{trackAssessment.targetAdherence.summary}</p>
                </article>
              )}

              {trackAssessment.flightTransition !== null && (
                <article className="track-assessor-energy-card">
                  <div className="track-assessor-energy-heading">
                    <h4>Transition to sustained flight</h4>
                    <span
                      className={`energy-rating energy-rating-${trackAssessment.flightTransition.rating}`}
                    >
                      {trackAssessment.flightTransition.label}
                    </span>
                  </div>
                  <p>{trackAssessment.flightTransition.summary}</p>
                </article>
              )}

              {trackAssessment.energyManagement !== null && (
                <article className="track-assessor-energy-card">
                  <div className="track-assessor-energy-heading">
                    <h4>Energy management</h4>
                    <span
                      className={`energy-rating energy-rating-${trackAssessment.energyManagement.rating}`}
                    >
                      {trackAssessment.energyManagement.label}
                    </span>
                  </div>
                  <p>{trackAssessment.energyManagement.summary}</p>
                </article>
              )}
            </div>

            <details className="track-assessor-evidence">
              <summary>Measurements behind this feedback</summary>
              <ul>
                {trackAssessment.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>
                Entry and exit GR use a two-second smoothed boundary sample.{" "}
                {assessorUsesCalculatedAirspeed
                  ? "The assessor uses calculated airspeed even when the graph is showing Raw values."
                  : "Ground-relative results remain provisional until wind data is loaded."}
              </p>
            </details>
          </div>
        </section>
      )}

      <div className="graph-view-container">
        <InteractiveTrackChart
          points={displayedGraphPoints}
          windowOffsetM={windowOffsetM}
          winds={historicalWinds}
          graphView={graphView}
          onGraphViewChange={setGraphView}
          scoreMode={jumpScoreMode}
          onScoreModeChange={setJumpScoreMode}
        />
      </div>

      <section className="card competition-lane-card">
        <h2>Competition Lane</h2>

        <p className="subtitle">
          Point A is estimated from the imported track at 9 seconds after detected exit.
          Enter or choose the competition reference point to draw the flown lane.
        </p>

        <div className="competition-lane-point-readout">
          <span>Point A</span>
          <strong>
            {pointA
              ? pointA.lat.toFixed(6) + ", " + pointA.lon.toFixed(6)
              : "Not detected"}
          </strong>
        </div>

        {savedReferenceGroupMatches.length > 0 && (
          <div className="analyzer-reference-suggestions">
            <h3>Saved competition location detected</h3>
            <p>
              Point A is near saved reference points. Choose the assigned point
              to check the flown track against its 600 m lane.
            </p>

            {savedReferenceGroupMatches.map(({ group, nearestDistanceM }) => (
              <div
                className={`analyzer-reference-group${
                  selectedCompetitionReferenceGroup?.id === group.id
                    ? " is-selected"
                    : ""
                }`}
                key={group.id}
              >
                <div className="analyzer-reference-group-title">
                  <strong>{group.name}</strong>
                  <span>
                    Nearest point {formatNumber(nearestDistanceM / 1852, 1)} NM
                    from Point A
                  </span>
                </div>

                <div className="analyzer-reference-options">
                  {group.points.map((point, index) => {
                    const pointIsSelected =
                      pointB !== null &&
                      Math.abs(point.lat - pointB.lat) < 0.000001 &&
                      Math.abs(point.lon - pointB.lon) < 0.000001;

                    return (
                      <button
                        type="button"
                        className={pointIsSelected ? "is-selected" : ""}
                        key={point.id}
                        onClick={() =>
                          selectAnalyzerSavedReferencePoint(group, point)
                        }
                      >
                        <span>
                          {index + 1}. {point.name}
                        </span>
                        <small>
                          {formatNumber(
                            distanceBetweenLatLonM(pointA, point) / 1852,
                            1,
                          )} NM from Point A
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="competition-reference-grid">
          <label>
            Reference Point latitude
            <input
              type="number"
              step="0.000001"
              value={competitionReferenceLat}
              placeholder="Example -33.123456"
              onChange={(event) => {
                setCompetitionReferenceLat(event.target.value);
                setCompetitionReferenceGroupId(null);
              }}
            />
          </label>

          <label>
            Reference Point longitude
            <input
              type="number"
              step="0.000001"
              value={competitionReferenceLon}
              placeholder="Example 151.123456"
              onChange={(event) => {
                setCompetitionReferenceLon(event.target.value);
                setCompetitionReferenceGroupId(null);
              }}
            />
          </label>
        </div>

        <div className="window-adjust-controls">
          <button
            type="button"
            onClick={() => {
              const openingMap = !showCompetitionReferencePicker;
              setShowCompetitionReferencePicker(openingMap);

              if (openingMap && userMapLocation === null) {
                requestUserMapLocation();
              }
            }}
          >
            {showCompetitionReferencePicker ? "Hide map" : "Choose Reference Point on map"}
          </button>

          <button
            type="button"
            onClick={() => {
              setCompetitionReferenceLat("");
              setCompetitionReferenceLon("");
              setCompetitionReferenceGroupId(null);
            }}
          >
            Clear Reference Point
          </button>
        </div>

        {showCompetitionReferencePicker && pointA && (
          <MapClickPicker
            referenceLat={competitionReferenceLat}
            referenceLon={competitionReferenceLon}
            userMapLocation={pointA}
            dropPoint={pointA}
            runHeadingDeg={laneHeadingDeg}
            trackPoints={fullJumpPoints}
            savedReferencePoints={selectedCompetitionReferencePointsForMap}
            onSavedReferencePointPick={(point) => {
              if (selectedCompetitionReferenceGroup) {
                selectAnalyzerSavedReferencePoint(
                  selectedCompetitionReferenceGroup,
                  point,
                );
              }
            }}
            onPick={(lat, lon) => {
              setCompetitionReferenceLat(lat.toFixed(6));
              setCompetitionReferenceLon(lon.toFixed(6));
              setCompetitionReferenceGroupId(null);
            }}
          />
        )}

        {pointA && pointB ? (
          <>
            <div className="competition-lane-point-readout">
              <span>Reference Point</span>
              <strong>
                {pointB.lat.toFixed(6) + ", " + pointB.lon.toFixed(6)}
              </strong>
            </div>

            {lanePenaltyEstimate && (
              <div
                className={`lane-penalty-estimate lane-penalty-${lanePenaltyEstimate.severity}`}
                role="status"
              >
                <span>Estimated lane result</span>
                <strong>{lanePenaltyEstimate.label}</strong>
                <p>
                  Maximum lateral distance: {formatNumber(
                    lanePenaltyEstimate.maxCenterlineDistanceM,
                    0,
                  )} m from the centreline. Maximum distance outside the 600 m
                  lane: {formatNumber(lanePenaltyEstimate.maxOutsideLaneM, 0)} m.
                </p>
                <small>
                  Calculated from the detected validation start through the
                  competition-window exit. This is an aid for review; official
                  penalties remain subject to judge verification.
                </small>
              </div>
            )}

          </>
        ) : (
          <p className="subtitle">
            Add a reference point to populate the 600 m lane and overlay the flown track.
          </p>
        )}
      </section>
    </>
    );

  })()}


      {selectedCompareTracks.length > 0 && (
        <div ref={compareChartSectionRef} className="compare-chart-anchor">
          <TrackComparisonChart
            tracks={selectedCompareTracks}
            windowOffsetM={windowOffsetM}
          />
        </div>
      )}


      <BottomBackButton
        label="Back to Home"
        onClick={() => setActivePage("landing")}
      />
    </main>
  );
}

if (activePage === "rules") {
  const fuse = new Fuse(faiRuleSections, {
  keys: ["id", "title", "text", "searchTerms"],
  threshold: 0.4,
  ignoreLocation: true,
  includeScore: true,
});

  const ruleResults =
    rulesSearchQuery.trim() === ""
      ? faiRuleSections
      : fuse
          .search(rulesSearchQuery)
          .map((result) => result.item)
          .filter((rule) => ruleMatchesSearchWords(rule, rulesSearchQuery));

  return (
    <main className="app">
      <header className="page-header">
        <button type="button" onClick={() => setActivePage("landing")}>
          Back to Home
        </button>

        <h1>FAI Rules Search</h1>
        <p className="subtitle">
          Search Performance Wingsuit and relevant Section 5 rules by keyword, phrase, or topic.
        </p>
      </header>

      <section className="card">
        <label>
          Search rules
          <input
            value={rulesSearchQuery}
            onChange={(event) => setRulesSearchQuery(event.target.value)}
            placeholder="Try: scoring window, GPS, penalty, exit altitude"
          />
        </label>

        <p className="subtitle">
          Showing {ruleResults.length} result
          {ruleResults.length === 1 ? "" : "s"}.
        </p>
      </section>

      {ruleResults.length === 0 ? (
        <section className="card">
          <h2>No matching rules found</h2>
          <p className="subtitle">
            Try another word or phrase, such as GPS, penalty, lane, window, exit,
            equipment, wingtip, or scoring.
          </p>
        </section>
      ) : (
        ruleResults.map((rule) => (
          <details className="card rule-result-card" key={rule.id}>
            <summary className="rule-result-summary">
              <span className="rule-result-title">{rule.title}</span>
              <span className="rule-result-id">{rule.id}</span>
            </summary>

            <div className="rule-result-body">
              <p>{highlightSearchText(rule.text, rulesSearchQuery)}</p>

              {rule.imageSrc && (
                <img
                  className="rule-result-image"
                  src={rule.imageSrc}
                  alt={rule.imageAlt ?? rule.title}
                />
              )}
            </div>
          </details>
        ))
      )}

      <BottomBackButton
        label="Back to Home"
        onClick={() => setActivePage("landing")}
      />
    </main>
  );
}

  if (activePage === "landing") {
    return (
      <main className={`app landing-page app-mode-${appMode}`}>
        <header className="app-header landing-header">
        <div className="landing-brand-block">
          <img
            className="app-logo landing-logo"
            src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
            alt="Numbers to Fly logo"
          />

          <p className="tagline">Performance Wingsuiting App.</p>
        </div>
          
          <button
            type="button"
            className="logbook-account-toggle"
            onClick={() => setShowLogbookLogin(true)}
          >
            {supabaseSession ? "Logbook account" : "Sign in / Create account"}
          </button>

          {showLogbookLogin && (
            <AuthModal
              session={supabaseSession}
              email={authEmail}
              status={authStatus}
              busy={authBusy}
              onEmailChange={setAuthEmail}
              onGoogleSignIn={handleGoogleSignIn}
              onGoogleSignInError={handleGoogleSignInError}
              onEmailLinkSignIn={handleEmailLinkSignIn}
              onSignOut={handleSignOut}
              onClose={() => setShowLogbookLogin(false)}
            />
          )}
          <div className="landing-actions">
            <button type="button" onClick={() => setActivePage("find")}>
              Numbers to fly
            </button>

            <button type="button" onClick={openFlyNumbersPage}>
              Fly the window
            </button>

            <button type="button" onClick={() => setActivePage("config")}>
              Config your Flysight
            </button>

            <button type="button" onClick={() => setActivePage("gps")}>
              GPS Track Analyzer
            </button>

            <button type="button" onClick={() => setActivePage("rules")}>
              FAI Rules Search
            </button>

            {savedLaneAvailable && (
              <button
                ref={flyMyLaneButtonRef}
                type="button"
                className="primary-action-button"
                onClick={() => setActivePage("lane")}
              >
                My Lane
              </button>

            )}
          </div>
        </header>
      </main>
    );
  }

  if (activePage === "find") {
    return (
      <main className="app">
        <header className="app-header">
          <img
            className="app-logo"
            src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
            alt="Numbers to Fly logo"
          />

          <p className="tagline">Find your Numbers</p>

          <button
            type="button"
            className="back-button"
            onClick={() => setActivePage("landing")}
          >
            Back
          </button>
        </header>

        <section className="card">
          <h2>Find your Numbers</h2>

          <p className="subtitle">
            Enter your body details and suit to estimate starting numbers.
          </p>

          <div className="find-details-actions">
            <button
              type="button"
              className="primary-action-button"
              onClick={toggleFindUnitSystem}
            >
              {findUnitSystem === "metric"
                ? "Switch to Imperial"
                : "Switch to Metric"}
            </button>
          </div>

          <div className="manual-wind-controls">
            <label>
              Weight, {findUnitSystem === "metric" ? "kg" : "lb"}
              <input
                type="number"
                value={findWeight}
                placeholder={
                  findUnitSystem === "metric" ? "Example 78" : "Example 175"
                }
                onChange={(e) => {
                  setFindWeight(e.target.value);
                  setFindNumbersOverride(null);
                  setFindDetailsStatus("");
                }}
              />
            </label>

            {findUnitSystem === "metric" ? (
              <label>
                Height, cm
                <input
                  type="number"
                  value={findHeightCm}
                  placeholder="Example 180"
                  onChange={(e) => {
                    setFindHeightCm(e.target.value);
                    setFindNumbersOverride(null);
                    setFindDetailsStatus("");
                  }}
                />
              </label>
            ) : (
              <>
                <label>
                  Height, feet
                  <input
                    type="number"
                    value={findHeightFeet}
                    placeholder="Example 5"
                    onChange={(e) => {
                      setFindHeightFeet(e.target.value);
                      setFindNumbersOverride(null);
                      setFindDetailsStatus("");
                    }}
                  />
                </label>

                <label>
                  Height, inches
                  <input
                    type="number"
                    value={findHeightInches}
                    placeholder="Example 11"
                    onChange={(e) => {
                      setFindHeightInches(e.target.value);
                      setFindNumbersOverride(null);
                      setFindDetailsStatus("");
                    }}
                  />
                </label>
              </>
            )}
          </div>

          <label>
            Suit setup
            <select
              value={findSuitSetup}
              onChange={(e) => {
                setFindSuitSetup(e.target.value as SuitSetup);
                setFindNumbersOverride(null);
                setFindDetailsStatus("");
              }}
            >
              <option value="" disabled>
                Select suit
              </option>
              <option value="crplus-no-wingtips">CR+ without wingtips</option>
              <option value="crplus-wingtips">CR+ with wingtips</option>
              <option value="freak-atc">Freak / ATC</option>
              <option value="swift">Swift</option>
            </select>
          </label>
        </section>

        <section className="card">
          <h2>Your Zero Wind Numbers</h2>

          {!hasFindInputs ? (
            <p className="subtitle">Please enter your height, weight and suit</p>
          ) : (
            <>
              <p className="subtitle">
                These start with the calculated estimates. Adjust them to match
                your training, then save them to your profile.
              </p>

              <div className="numbers-grid editable-find-numbers-grid">
                <label className="number-tile">
                  <span>Distance speed, km/h</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editableFindNumbers.distanceSpeedKph}
                    onChange={(event) =>
                      updateFindNumber("distanceSpeedKph", event.target.value)
                    }
                  />
                </label>

                <label className="number-tile">
                  <span>Time speed, km/h</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editableFindNumbers.timeSpeedKph}
                    onChange={(event) =>
                      updateFindNumber("timeSpeedKph", event.target.value)
                    }
                  />
                </label>

                <label className="number-tile">
                  <span>Speed start GR</span>
                  <input
                    type="number"
                    min="0.05"
                    step="0.05"
                    value={editableFindNumbers.speedStartGR}
                    onChange={(event) =>
                      updateFindNumber("speedStartGR", event.target.value)
                    }
                  />
                </label>

                <label className="number-tile">
                  <span>Speed end GR</span>
                  <input
                    type="number"
                    min="0.05"
                    step="0.05"
                    value={editableFindNumbers.speedEndGR}
                    onChange={(event) =>
                      updateFindNumber("speedEndGR", event.target.value)
                    }
                  />
                </label>
              </div>

              <div className="find-number-actions">
                <button
                  type="button"
                  onClick={resetFindNumbersToEstimates}
                  disabled={findNumbersOverride === null}
                >
                  Reset to estimates
                </button>

                <button
                  type="button"
                  className="primary-action-button"
                  onClick={() => void saveFindDetails()}
                  disabled={
                    findDetailsBusy ||
                    !findNumbersAreValid ||
                    !supabaseSession
                  }
                >
                  {findDetailsBusy ? "Saving..." : "Save my profile"}
                </button>

                <button
                  type="button"
                  className="primary-action-button"
                  onClick={pushAllFoundNumbersToFlyPage}
                  disabled={!findNumbersAreValid}
                >
                  Push all numbers to Fly your Numbers
                </button>
              </div>
            </>
          )}

          {findDetailsStatus && (
            <p className="find-details-status" aria-live="polite">
              {findDetailsStatus}
            </p>
          )}

          <p className="calculator-disclaimer">
            Starting point only. Refine these numbers with actual training data,
            suit setup, FlySight data, and coaching feedback.
          </p>
                </section>

        <section className="card tutorial-card">
          <h2>How do I fly the numbers?</h2>

          <p>
            Choose a task to see how to use the numbers in flight and how the
            FlySight tones can help you stay in the right performance range.
          </p>

          <div className="find-help-buttons">
            <button
              type="button"
              className="find-help-button"
              onClick={() =>
                setActiveFindHelp(activeFindHelp === "speed" ? null : "speed")
              }
            >
              Speed
            </button>

            <button
              type="button"
              className="find-help-button"
              onClick={() =>
                setActiveFindHelp(activeFindHelp === "time" ? null : "time")
              }
            >
              Time
            </button>

            <button
              type="button"
              className="find-help-button"
              onClick={() =>
                setActiveFindHelp(
                  activeFindHelp === "distance" ? null : "distance"
                )
              }
            >
              Distance
            </button>
          </div>
        </section>

                {activeFindHelp !== null && (
          <div
            className="find-help-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => setActiveFindHelp(null)}
          >
            <section
              className="find-help-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="find-help-close"
                aria-label="Close help"
                onClick={() => setActiveFindHelp(null)}
              >
                ×
              </button>

              {activeFindHelp === "speed" && (
                <>
                  <h2>Flying Speed Numbers</h2>

                  <p>
                    For Speed, you will be shown a start GR, and an end GR. The
                    idea is that if you fly too steep, you will not create
                    enough horizontal speed. If you fly too flat, you will
                    present too much surface area and make your angle of
                    attack too high, which will slow you down.
                  </p>

                  <p>
                    There is an ideal angle of flight for every person based on
                    their height, weight and suit. Aim to enter
                    the window at the start GR, then control the suit so the GR
                    slowly increases through the whole speed window.The suit will want to 
                    flatten out because of how loaded it is with energy, it's up to you
                    to control how much you let the GR increase.
                  </p>

                  <p>
                    The goal is to finish the window near the end GR with good
                    speed.
                  </p>

                  <p>
                    The tones help you monitor your performance through a speed
                    range. Low tones mean you are below the target range. High
                    tones mean you are flying well. Use Configure FlySight to
                    lower or increase the tone range when needed.
                  </p>
                </>
              )}

              {activeFindHelp === "time" && (
                <>
                  <h2>Flying Time Numbers</h2>

                  <p>
                    For Time, the goal is to fly the lowest sustainable
                    vertical speed. If you have a good wing configuration and fly
                    the correct airspeed, the suit should stay efficient through
                    the window. It is okay to lose around 20 km/h through the window.
                  </p>

                  <p>
                    If your horizontal and vertical speed are higher than expected, you may be flying too
                    steep. If your horizontal speed is lower, you may be flying too flat, you may have 
                    heard good tones for a while but the suit can not create sufficient lift
                    when the airpseed gets too low.
                    
                  </p>

                  <p>                 
                    We cannot directly measure airspeed in freefall, but we know our ground
                    speed and can calculate the effect of the winds. A useful rule of thumb
                    is to add about 1 km/h to your target speed for every knot of tailwind.

                    For example, if your zero-wind target speed is 150 km/h and you have a 
                    20 kt tailwind, your new target speed is about 170 km/h.
                  </p>

                  <p>
                    For Time, monitor vertical speed using the tone feature on
                    your FlySight. A range will be set for what is good and bad
                    in the Configure Flysight page, from the information you provide 
                    here. Listen for the tone changing as your performance
                    changes. This gives live feedback in the actual conditions.
                    
                  </p>

                  <p>
                    If you are always flying better than the set tone range, try
                    adjusting the targets in Configure FlySight to give yourself
                    a better performance range.
                  </p>
                </>
              )}

              {activeFindHelp === "distance" && (
                <>
                  <h2>Flying Distance Numbers</h2>

                  <p>
                    For Distance, the goal is to fly the best sustainable GR. 
                    If you have a clean wing configuration and fly the correct
                    airspeed, the suit should stay efficient through the window.                    
                  </p>

                  <p>
                    If your horizontal speed is higher than expected, you may be 
                    flying too steep. If your horizontal speed is lower, you may be 
                    flying too flat, which is usually not sustainable.
                  </p>
                  <p>
                    We cannot directly measure airspeed in freefall, but we know
                    our ground speed and can calculate the effect of the winds.
                    A useful rule of thumb is to add about 1 km/h to your target
                    speed for every knot of tailwind.
                  </p>

                  <p>
                    For example, if your zero-wind target speed is 185 km/h and
                    you have a 20 kt tailwind, your new target speed is about
                    205 km/h. Your GR will also increase by around 0.1 for every 
                    10kts of tailwind.
                  </p>

                  <p>
                    It is okay to lose around 20 km/h through the window. That
                    should still leave enough energy to increase your glide
                    ratio over the last 100 m. There is no point crossing the
                    finish line with anything left in the tank.
                  </p>

                  <p>
                    For Distance, monitor glide ratio using FlySight tones. Low
                    tones mean you are below the target range. High tones mean
                    you are flying well.
                  </p>
                </>
              )}

              <p>
                Upper winds are extremely important for all of this. Your
                FlySight config files may need to change between different days
                as conditions change.
              </p>

                <p>
                    You can go directly to "Config your Flysight" if you know the 
                    adjusted numbers you want to fly. Follow the steps through 
                    "Numbers to Fly" - "Fly the Window" - "Config your Flysight"
                    if you need more help to determine your numbers. 
                  </p>
            </section>
          </div>
        )}

        <BottomBackButton
          label="Back to Home"
          onClick={() => setActivePage("landing")}
      />
      </main>
    );
  }

  if (activePage === "config") {
    return (
      <main className="app">
        <header className="app-header">
          <img
            className="app-logo"
            src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
            alt="Numbers to Fly logo"
          />

          <p className="tagline">Configure FlySight</p>

          <button
            type="button"
            className="back-button"
            onClick={() => setActivePage("landing")}
          >
            Back
          </button>
        </header>

        <section className="card">
          <h2>FlySight Config Builder</h2>

          <p className="subtitle">
            Generate task-specific FlySight settings. The same config format
            works for FlySight 1 and FlySight 2.
          </p>

          <label>
            Task
            <select
              value={configTask}
              onChange={(e) => {
                const nextTask = e.target.value as ConfigTask;
                const storedPreset = storedConfigTonePresets[nextTask];

                setConfigTask(nextTask);
                applyConfigAlarmDefaults(nextTask);

                if (storedPreset) {
                  setConfigToneMin(storedPreset.toneMin);
                  setConfigToneMax(storedPreset.toneMax);
                  return;
                }

                applyConfigTonePreset(nextTask, configSuit);
              }}
            >
              <option value="distance">Distance</option>
              <option value="speed">Speed</option>
              <option value="time">Time</option>
            </select>
          </label>          

          <label>
            Suit
            <select
              value={configSuit}
              onChange={(e) => updateConfigSuit(e.target.value as ConfigSuit)}
            >
              <option value="crplus-wingtips">CR+ with wingtips</option>
              <option value="crplus-no-wingtips">CR+ without wingtips</option>
              <option value="freak">Freak</option>
              <option value="atc">ATC</option>
              <option value="swift">Swift</option>
            </select>
          </label>

          <div className="manual-wind-controls">
            <label>
              DZ elevation, m
              <input
                type="number"
                value={configDzElevM}
                placeholder="Example 4"
                onChange={(e) => setConfigDzElevM(e.target.value)}
              />
            </label>

            <label>
              Timezone offset, hours
              <input
                type="number"
                value={configTimezoneOffsetHours}
                placeholder="Example 11"
                onChange={(e) => setConfigTimezoneOffsetHours(e.target.value)}
              />
            </label>

            <button type="button" onClick={useDeviceTimezoneForConfig}>
              Use phone timezone
            </button>
          </div>

          <div className="manual-wind-controls">
            <label>
              Tone minimum {configTask === "distance" ? "GR" : "km/h"}
              <input
                className={toneRangeInvalid ? "invalid-input" : ""}
                type="number"
                step={configTask === "distance" ? "0.1" : "1"}
                value={configToneMin}
                placeholder={
                  configTask === "distance" ? "Example 3.4" : "Example 270"
                }
                onChange={(e) => setConfigToneMin(e.target.value)}
/>            </label>

            <label>
              Tone maximum {configTask === "distance" ? "GR" : "km/h"}
              <input
                className={toneRangeInvalid ? "invalid-input" : ""}
                type="number"
                step={configTask === "distance" ? "0.1" : "1"}
                value={configToneMax}
                placeholder={
                  configTask === "distance" ? "Example 3.8" : "Example 290"
                }
                onChange={(e) => setConfigToneMax(e.target.value)}
/>              
            </label>
          </div>
          {toneRangeInvalid && (
           <p className="field-warning">
             Tone maximum must be greater than tone minimum.
          </p>
)}

{configTask === "distance" && (
  <p className="subtitle">
    {getConfigWindSummary(results).averageTailwindKt >= 0
      ? "Distance GR tones include the current flight path wind adjustment. Tailwind adds about 0.1 GR for every 10 kt."
      : "Distance GR tones include the current flight path wind adjustment. This flight path has a headwind component. Fly your normal zero-wind speed and accept that the achievable glide ratio will be lower. Headwind reduces the expected GR by about 0.2 for every 10 kt."}
  </p>
)}
{configTask === "distance" && (
  <section className="card tutorial-card">
    <h2>Understanding GR Tone Settings</h2>

    <p>
      The maximum tone should be a glide ratio that is relatively high, but
      realistically achievable for the suit and pilot.
    </p>

    <p>
      You may be capable of flying a higher number, but the goal is not to chase
      the highest GR possible. If the maximum tone is set too high, there&apos;s a
      chance that you may increase the Angle of Attack (AoA) too much, lose
      airspeed, and then struggle to sustain high performance through the window.
    </p>

    <p>
      A high but achievable maximum tone lets the pilot know they are flying
      well while keeping focus on good wing configuration and maintaining the
      speed needed to sustain a high glide ratio through the window.
    </p>

    <p>
      The minimum tone is set 0.4 GR below the maximum tone. This gives a useful
      working range and allows the pilot to understand the effect that
      adjustments are having on the suits performance.
    </p>

    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        This flight path has a headwind component. For Distance, do not chase a
        higher glide ratio by slowing the suit down. Fly your normal zero-wind
        speed and accept that the achievable glide ratio will be lower.
      </p>
    )}

    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        In a headwind, be less aggressive with your flare for Time and Distance.
        The suit will lose ground speed more rapidly, so an overly aggressive
        flare can make it harder to keep the suit flying efficiently through the
        window.
      </p>
    )}
  </section>
)}

{configTask === "time" && (
  <section className="card tutorial-card">
    <h2>Understanding Time Tone Settings</h2>

    <p>
      For Time, the low tone should be an achievable vertical speed that helps
      confirm you are flying well without forcing you to fly too slowly and risk
      stalling the suit.
    </p>

    <p>
      It&apos;s great if you&apos;re actually flying slower than the lowest tone, but
      you do not need to know that exact number. You only need to know that you
      are in a good range and that the suit is still flying cleanly. If you&apos;re
      consistently flying well below the minimum tone you can lower the number
      manually in the above window.
    </p>

    <p>
      Focus on maintaining a good wing configuration, managing your horizontal
      speed, and using your senses of wind speed, wind noise, and suit pressure
      to feel whether you can ask the suit for more or whether you need to hold
      what you have.
    </p>

    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        This flight path has a headwind component. For Time, the wind does not
        change the suit&apos;s airspeed performance, but it does change the
        ground-speed number to fly. A 10 kt direct headwind component would 
        allow you to fly about 10 km/h slower over the ground while keeping
        the same airspeed and wing configuration. This calculation will change 
        as the wind becomes more of a crosswind.
        
      </p>
    )}



    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        In a headwind, be less aggressive with your flare for Time and Distance.
        The suit will lose ground speed more rapidly, so an overly aggressive
        flare can make it harder to keep the suit flying efficiently through the
        window.
      </p>
    )}
  </section>
)}
{configTask === "speed" && (
  <section className="card tutorial-card">
    <h2>Understanding Speed Tone Settings</h2>

    <p>
      For Speed, the maximum tone should be an achievable high speed. You may
      peak at a higher speed during your run, but the goal is to set a high tone
      that confirms you are flying well without encouraging you to chase an
      unrealistic number.
    </p>

    <p>
      As long as you keep hearing the high tones and maintain the correct wing
      configuration and glide ratio, you know you are flying a good run.
    </p>

    <p>
      If you flatten out too much and make the glide ratio go higher than
      desired, do not push back down aggressively on the suit. That will usually
      slow your horizontal speed for longer than any benefit you gain from trying
      to rebuild energy.
    </p>

    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        This flight path has a headwind component. For Speed, you should expect
        a slower peak ground speed because the score is measured over the ground,
        not through the air.
      </p>
    )}

    {getConfigWindSummary(results).averageTailwindKt < 0 && (
      <p>
        In a headwind, it is important to keep the end glide ratio lower and
        avoid flattening the suit too much. A steeper GR helps maintain  
        energy and creates the best horizontal speed in these conditions.
        
      </p>
    )}
  </section>
)}
        </section>

        <section className="card">
          <h2>Alarm Elevations</h2>

          <p className="subtitle">
            Values are metres above ground level, using DZ_Elev as the ground
            elevation reference.
          </p>
          <p className="subtitle">
            The “9” alarm is the maximum competition exit altitude warning. If you hear
            it, the aircraft is too high and any record may be void.
          </p>

          <div className="alarm-help-action">
            <button type="button" onClick={() => setShowAlarmHelp(true)}>
              How do I use these alarms?
            </button>
          </div>

          {showAlarmHelp && (
            <div
              className="find-help-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="alarm-help-title"
              onClick={() => setShowAlarmHelp(false)}
            >
              <section
                className="find-help-modal alarm-help-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="find-help-close"
                  aria-label="Close alarm help"
                  onClick={() => setShowAlarmHelp(false)}
                >
                  ×
                </button>

                <h2 id="alarm-help-title">How to use the alarms</h2>

                <p>
                  For Time and Distance, the countdown alarms are spaced 100 m apart.
                  Use them to time a smooth transition from a steep dive into flat
                  flight before the scoring window begins.
                </p>

                <h3>Build speed, then recover smoothly</h3>
                <p>
                  Holding a steeper dive builds vertical speed. A well-timed recovery
                  converts that energy into horizontal speed and lift. The aim is not
                  to pull out abruptly, but to use the countdown to make one smooth,
                  controlled transition.
                </p>

                <h3>When to start the recovery</h3>
                <p>
                  If you have not built up the confidence for a very steep dive, 
                  or are flying a suit with a shorter recovery arc than a competition suit,
                  you may only need to start coming out of the dive when you hear “3”.
                  Aim to be in flat flight with a glide ratio above 2 just before
                  the beep that starts the scoring window. You will then be ready to flare
                  and boost your Time or Distance score.
                </p>

                <h3>Time and Distance need different flares</h3>
                <p>
                  For Time, the flare can be more aggressive because you can use more
                  of your excess speed to create lift and stay in the window longer.
                  For Distance, preserve more horizontal speed and project the flight
                  forward. The target speed for Distance is often around 20% higher
                  than for Time—for example, about 185 km/h for Distance versus 150
                  km/h for Time—so avoid spending too much energy gaining altitude.
                </p>

                <h3>Speed task</h3>
                <p>
                  For Speed, the countdown alarms are set with the same interval, but 100 m above the scoring
                  window. This lets you hear the glide-ratio feedback before you enter
                  the window, giving you time to settle onto the required start glide
                  ratio.
                </p>
              </section>
            </div>
          )}

          {configTask === "speed" && (
            <p className="subtitle">
              For Speed, the countdown alarms are raised by 100 m. This gives you about
              100 m after the beep to hear the glide ratio feedback and settle closer to
              the target GR before entering the scoring window.
            </p>
          )}

          <div className="alarm-grid">
            <label>
              Max exit altitude / 9
              <input
                type="number"
                value={configAlarm9}
                onChange={(e) => setConfigAlarm9(e.target.value)}
              />
            </label>

            <label>
              5
              <input
                type="number"
                value={configAlarm5}
                onChange={(e) => setConfigAlarm5(e.target.value)}
              />
            </label>

            <label>
              4
              <input
                type="number"
                value={configAlarm4}
                onChange={(e) => setConfigAlarm4(e.target.value)}
              />
            </label>

            <label>
              3
              <input
                type="number"
                value={configAlarm3}
                onChange={(e) => setConfigAlarm3(e.target.value)}
              />
            </label>

            <label>
              2
              <input
                type="number"
                value={configAlarm2}
                onChange={(e) => setConfigAlarm2(e.target.value)}
              />
            </label>

            <label>
              1
              <input
                type="number"
                value={configAlarm1}
                onChange={(e) => setConfigAlarm1(e.target.value)}
              />
            </label>

            <label>
              Beep
              <input
                type="number"
                value={configAlarmBeep}
                onChange={(e) => setConfigAlarmBeep(e.target.value)}
              />
            </label>

            <label>
              Flare
              <input
                type="number"
                value={configAlarmFlare}
                onChange={(e) => setConfigAlarmFlare(e.target.value)}
              />
            </label>

            <label>
              Task reminder
              <input
                type="number"
                value={configAlarmTask}
                onChange={(e) => setConfigAlarmTask(e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Generated Config</h2>

          <p className="subtitle">
            Copy or download this config and use it for either FlySight version.
          </p>          
          <div className="config-actions">
            <button
              type="button"
              onClick={copyGeneratedConfig}
              disabled={toneRangeInvalid}
            >
              Copy config
            </button>

            <button
              type="button"
              onClick={downloadGeneratedConfig}
              disabled={toneRangeInvalid}
            >
              Download TXT
            </button>
          </div>

          {copyStatus && <p className="subtitle">{copyStatus}</p>}

          <textarea
            className="config-preview"
            value={generatedConfigText}
            readOnly
          />
        </section>

        <BottomBackButton
          label="Back to Home"
          onClick={() => setActivePage("landing")}
      />
      </main>
    );
  }

  return (
    <main className="app">
      <header className="app-header">
        <img
          className="app-logo"
          src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
          alt="Numbers to Fly logo"
        />

        <p className="tagline">Fly your Numbers</p>

        <button
          type="button"
          className="back-button"
          onClick={() => setActivePage("landing")}
        >
          Back
        </button>
      </header>

      <section className="card">
        <h2>Setup</h2>

        <p className="subtitle">
          These targets automatically follow your current Find Your Numbers
          details. You can still adjust them here for a specific jump.
        </p>

        <label>
          Task
          <select
            value={taskMode}
            onChange={(e) => handleFlyTaskModeChange(e.target.value as TaskMode)}
          >
            <option value="time">Time</option>
            <option value="distance">Distance</option>
            <option value="speed">Speed</option>
          </select>
        </label>

        {taskMode === "speed" ? (
          <>
            <label>
              Start GR at 2500 m
              <input
                type="number"
                step="0.05"
                value={startGR}
                placeholder="Example 1.10"
                onChange={(e) => setStartGR(e.target.value)}
              />
            </label>

            <label>
              End GR at 1500 m
              <input
                type="number"
                step="0.05"
                value={endGR}
                placeholder="Example 1.70"
                onChange={(e) => setEndGR(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            Zero-wind target speed, km/h
            <input
              type="number"
              value={zeroWindSpeedKph}
              placeholder="Example 185"
              onChange={(e) => setZeroWindSpeedKph(e.target.value)}
            />
          </label>
        )}

        <label>
          Drop distance from reference point, NM
          <input
            ref={dropDistanceInputRef}
            type="number"
            step="0.1"
            value={dropDistanceNm}
            placeholder="Example 3.0"
            onChange={(event) => setDropDistanceNm(event.target.value)}
            onBlur={() => {
              if (Number(dropDistanceNm) <= 0) {
                return;
              }

              const inputTop =
                dropDistanceInputRef.current?.getBoundingClientRect().top;

              const buttonTop =
                referenceButtonRef.current?.getBoundingClientRect().top;

              if (inputTop === undefined || buttonTop === undefined) {
                return;
              }

              window.scrollBy({
                top: buttonTop - inputTop,
                behavior: "smooth",
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <h2>Reference Point</h2>

        <p className="subtitle">
          Choose the competition reference point on the map or enter its
          latitude and longitude.
        </p>

        <div className="reference-method-actions">
          <button
            ref={referenceButtonRef}
            type="button"
            className="primary-action-button"
            onClick={toggleMapPicker}
          >
            {showMapPicker ? "Hide map" : "Choose your reference point"}
          </button>

          <button
            type="button"
            className="primary-action-button"
            aria-expanded={showLatLonEntry}
            onClick={toggleLatLonEntry}
          >
            {showLatLonEntry
              ? "Hide Lat/Lon entry"
              : "Enter your Lat/Lon reference"}
          </button>

          <button
            type="button"
            className="primary-action-button saved-reference-points-toggle"
            aria-expanded={showSavedReferencePoints}
            onClick={() => {
              const openingSavedPoints = !showSavedReferencePoints;

              setShowSavedReferencePoints(openingSavedPoints);
              setSavedReferencePointStatus("");

              if (openingSavedPoints && selectedReferencePointGroup) {
                openReferenceMapAndScroll();
              }
            }}
          >
            {showSavedReferencePoints
              ? "Hide saved reference points"
              : `Saved reference points (${totalSavedReferencePoints})`}
          </button>
        </div>

        {locationStatus && <p className="subtitle">{locationStatus}</p>}

        {showSavedReferencePoints && (
          <div className="saved-reference-panel">
            <h3>Competition reference points</h3>

            <p className="saved-reference-help">
              Store up to {MAX_REFERENCE_POINTS_PER_GROUP} points for each
              location. They will remain available on this device for future
              competitions.
            </p>

            <label>
              Competition location
              <select
                value={savedReferencePointStore.activeGroupId ?? ""}
                onChange={(event) =>
                  selectReferencePointGroup(event.target.value)
                }
              >
                <option value="">Create a new location...</option>
                {savedReferencePointStore.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.points.length}/
                    {MAX_REFERENCE_POINTS_PER_GROUP})
                  </option>
                ))}
              </select>
            </label>

            {selectedReferencePointGroup && (
              <>
                <div className="saved-reference-group-heading">
                  <div>
                    <strong>{selectedReferencePointGroup.name}</strong>
                    <span>
                      {selectedReferencePointGroup.points.length} of{" "}
                      {MAX_REFERENCE_POINTS_PER_GROUP} points saved
                    </span>
                  </div>

                  <button
                    type="button"
                    className="saved-reference-danger-button"
                    onClick={() =>
                      deleteSavedReferencePointGroup(
                        selectedReferencePointGroup,
                      )
                    }
                  >
                    Delete location
                  </button>
                </div>

                {selectedReferencePointGroup.points.length > 0 ? (
                  <div className="saved-reference-list">
                    {selectedReferencePointGroup.points.map((point, index) => (
                      <div className="saved-reference-row" key={point.id}>
                        <button
                          type="button"
                          className="saved-reference-use-button"
                          onClick={() =>
                            void loadSavedReferencePoint(
                              selectedReferencePointGroup,
                              point,
                            )
                          }
                        >
                          <span>
                            {index + 1}. {point.name}
                          </span>
                          <small>
                            {point.lat.toFixed(6)}, {point.lon.toFixed(6)}
                          </small>
                        </button>

                        <button
                          type="button"
                          className="saved-reference-delete-button"
                          aria-label={`Delete ${point.name}`}
                          onClick={() =>
                            deleteSavedReferencePoint(
                              selectedReferencePointGroup,
                              point,
                            )
                          }
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="saved-reference-empty">
                    No points saved for this location yet.
                  </p>
                )}
              </>
            )}

            <form
              className="save-reference-form"
              onSubmit={saveCurrentReferencePoint}
            >
              <h4>Save the current reference point</h4>

              {!selectedReferencePointGroup && (
                <label>
                  New competition location name
                  <input
                    type="text"
                    maxLength={60}
                    value={newReferenceGroupName}
                    placeholder="Example: Skydive Ramblers"
                    onChange={(event) => {
                      setNewReferenceGroupName(event.target.value);
                      setSavedReferencePointStatus("");
                    }}
                  />
                </label>
              )}

              <label>
                Reference point label
                <input
                  type="text"
                  maxLength={40}
                  value={savedReferencePointName}
                  placeholder={`Example: Reference ${
                    (selectedReferencePointGroup?.points.length ?? 0) + 1
                  }`}
                  onChange={(event) => {
                    setSavedReferencePointName(event.target.value);
                    setSavedReferencePointStatus("");
                  }}
                />
              </label>

              <p className="saved-reference-current-point">
                Current point:{" "}
                <strong>
                  {referenceLat && referenceLon
                    ? `${referenceLat}, ${referenceLon}`
                    : "Choose or enter a point first"}
                </strong>
              </p>

              <p className="saved-reference-help">
                Reusing an existing label updates that saved point.
              </p>

              <button type="submit" className="primary-action-button">
                {selectedReferencePointGroup
                  ? "Save current point"
                  : "Create location and save point"}
              </button>
            </form>

            {savedReferencePointStatus && (
              <p className="saved-reference-status" role="status">
                {savedReferencePointStatus}
              </p>
            )}
          </div>
        )}

        {showMapPicker && (
          <div ref={mapPickerSectionRef}>
            {showLatLonEntry && (
              <form
                className="reference-coordinate-form"
                onSubmit={handleLatLonReferenceSubmit}
              >
                <div className="reference-coordinate-grid">
                  <label>
                    Latitude
                    <input
                      type="number"
                      inputMode="decimal"
                      min="-90"
                      max="90"
                      step="0.000001"
                      value={referenceLatInput}
                      placeholder="Example -33.123456"
                      onChange={(event) => {
                        setReferenceLatInput(event.target.value);
                        setLatLonEntryError("");
                      }}
                      required
                    />
                  </label>

                  <label>
                    Longitude
                    <input
                      type="number"
                      inputMode="decimal"
                      min="-180"
                      max="180"
                      step="0.000001"
                      value={referenceLonInput}
                      placeholder="Example 151.123456"
                      onChange={(event) => {
                        setReferenceLonInput(event.target.value);
                        setLatLonEntryError("");
                      }}
                      required
                    />
                  </label>
                </div>

                {latLonEntryError && (
                  <p className="reference-coordinate-error" role="alert">
                    {latLonEntryError}
                  </p>
                )}

                <button type="submit" className="primary-action-button">
                  Use this reference point
                </button>
              </form>
            )}

            <p className="subtitle">
              Green is within 7.5° of
              the best tailwind heading, orange is within 15°, and red is
              outside that range.
            </p>

          <div className="reference-map-shell">
            <MapClickPicker
              referenceLat={referenceLat}
              referenceLon={referenceLon}
              userMapLocation={userMapLocation}
              dropPoint={calculatedDropPoint}
              onPick={pickReferenceFromMap}
              savedReferencePoints={selectedSavedReferencePointsForMap}
              runHeadingDeg={runHeadingDeg}
              laneColor={windAdvantage.color}
            />
          </div>

      <div className="compact-heading-card">
        <HeadingSlider
          runHeadingDeg={runHeadingDeg}
          windAdvantage={windAdvantage}
          windSourceUnavailable={fetchStatus.includes("Could not fetch")}
          onInteractionStart={() => setShowTemporaryFlightLine(true)}
          onInteractionEnd={() => {
            setShowTemporaryFlightLine(false);

            window.setTimeout(() => {
              flyMyLaneButtonRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
            }, 100);
          }}
          onChange={updateHeadingFromSlider}
        />
        </div>

              <div className="compact-wind-card">
                <h2>Wind Forecasts</h2>

                <label>
                  <select
                    value={windSource}
                    onChange={(e) => handleWindSourceChange(e.target.value as WindSource)}
                  >
                    <option value="open-meteo">Open-Meteo</option>
                    <option value="mark-schulze">Mark Schulze</option>
                    <option value="meteomatics">Meteomatics</option>
                    <option value="manual">Manual</option>
                    <option value="windy">Windy visual check</option>
                  </select>
                  <div className="window-adjust-controls">
                    <button
                      type="button"
                      onClick={() =>
                        setForecastHourOffset((current) => current - 1)
                      }
                    >
                      -1 hour
                    </button>

                    <button
                      type="button"
                      onClick={() => setForecastHourOffset(0)}
                    >
                      Now
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setForecastHourOffset((current) => current + 1)
                      }
                    >
                      +1 hour
                    </button>
                  </div>

                  <p className="subtitle">
                    Forecast time:{" "}
                    <strong>
                      {new Date(
                        Date.now() + forecastHourOffset * 60 * 60 * 1000
                      ).toLocaleString()}
                    </strong>
                  </p>
                </label>

                {windSource === "windy" && (
                  <button type="button" onClick={openWindyVisualCheck}>
                    Open Windy visual check
                  </button>
                )}

                {fetchStatus && <p className="subtitle">{fetchStatus}</p>}

                <button
                  type="button"
                  onClick={() => setShowRawWinds((current) => !current)}
                >
                  {showRawWinds ? "Hide raw winds" : "Show raw winds"}
                </button>

                {showRawWinds && (
                  <>
                    <p className="subtitle">
                      Raw winds used by the calculator. You can edit these manually if
                      needed.
                    </p>

                    <div className="manual-wind-controls">
                      <label>
                        Set all wind from, degrees
                        <input
                          type="number"
                          value={globalWindFromDeg}
                          placeholder="Example 270"
                          onChange={(e) => setGlobalWindFromDeg(e.target.value)}
                        />
                      </label>

                      <label>
                        Set all wind speed, kt
                        <input
                          type="number"
                          value={globalWindSpeedKt}
                          placeholder="Example 20"
                          onChange={(e) => setGlobalWindSpeedKt(e.target.value)}
                        />
                      </label>

                      <button type="button" onClick={applyGlobalWindToAll}>
                        Apply to all altitudes
                      </button>
                    </div>

                    <table>
                      <thead>
                        <tr>
                          <th>Altitude</th>
                          <th>Wind from</th>
                          <th>Speed</th>
                        </tr>
                      </thead>

                      <tbody>
                        {winds.map((wind) => (
                          <tr key={wind.altitudeM}>
                            <td>{wind.altitudeM} m</td>
                            <td>
                              <input
                                className="table-input"
                                type="number"
                                value={wind.directionFromDeg}
                                placeholder="270"
                                onChange={(e) =>
                                  updateWind(
                                    wind.altitudeM,
                                    "directionFromDeg",
                                    e.target.value
                                  )
                                }
                              />
                            </td>
                            <td>
                              <input
                                className="table-input"
                                type="number"
                                value={wind.speedKt}
                                placeholder="20"
                                onChange={(e) =>
                                  updateWind(wind.altitudeM, "speedKt", e.target.value)
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>


        <button
              ref={flyMyLaneButtonRef}
              type="button"
              className="primary-action-button fly-lane-next-button"
              onClick={() => setActivePage("lane")}
            >
              Fly my Lane
            </button>
            </div>
        )}

        {calculatedDropPoint && (
          <p className="subtitle">
            Drop/start point: {calculatedDropPoint.lat.toFixed(6)},{" "}
            {calculatedDropPoint.lon.toFixed(6)}
          </p>
        )}

        {referenceStatus && <p className="subtitle">{referenceStatus}</p>}
      </section>

      <section className="card">
        <h2>Numbers to Fly</h2>

        <table>
          <thead>
            <tr>
              <th>Alt</th>
              <th>T/H</th>
              <th>Xwind</th>
              {taskMode === "speed" && <th>Eff</th>}
              <th>{taskMode === "speed" ? "GR" : "Speed"}</th>
            </tr>
          </thead>

          <tbody>
            {results.map((row) => (
              <tr key={row.altitudeM}>
                <td>{row.altitudeM} m</td>
                <td>{row.tailwindKt} kt</td>
                <td>{row.crosswindKt} kt</td>
                {taskMode === "speed" && <td>{row.effectiveWindAheadKt} kt</td>}
                <td>
                  {taskMode === "speed"
                    ? row.targetGR?.toFixed(2)
                    : `${row.targetSpeedKph} km/h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <TargetGraph taskMode={taskMode} results={results} />

<section className="card">
  <button
    type="button"
    className="primary-action-button"
    onClick={pushFlyNumbersToConfig}
  >
    Push to Config my Numbers
  </button>

  <p className="subtitle">
    Stores Distance, Speed, and Time tone settings using the current suit, body
    inputs, and flight path wind calculation.
  </p>
</section>
    </main>
  );
}

export default App;


