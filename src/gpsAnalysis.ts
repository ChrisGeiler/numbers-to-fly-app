export type GpsTrackPoint = {
  time: string;
  timestampMs: number | null;
  lat: number;
  lon: number;
  velNMps: number;
  velEMps: number;
  altitudeM: number;
  horizontalSpeedMps: number;
  verticalSpeedMps: number;
  totalSpeedMps: number;
  glideRatio: number | null;
};

export const GPS_SAMPLE_PERIOD_SECONDS = 0.2;

const EXIT_VERTICAL_SPEED_TRIGGER_KMH = 9;
const EXIT_CONFIRMATION_ALTITUDE_LOSS_M = 50;
const COMPETITION_MAX_EXIT_ALTITUDE_M = 3353;
const COMPETITION_DIVE_TRIGGER_DEG = 40;
const COMPETITION_DIVE_ANGLE_TOLERANCE_DEG = 1.5;
const COMPETITION_DIVE_MIN_RISE_DEG = 10;
const COMPETITION_DIVE_MIN_SAMPLES = 4;
const COMPETITION_DIVE_MAX_LOOKBACK_SECONDS = 5;

function parseNumber(value: string | undefined) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

export function parseFlySightCsv(csvText: string): GpsTrackPoint[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const delimiter = lines[0].includes("\t") ? "\t" : ",";

  const headers = lines[0]
    .split(delimiter)
    .map((header) => header.trim());

  const getIndex = (...names: string[]) =>
    headers.findIndex((header) =>
      names.some((name) => header.toLowerCase() === name.toLowerCase())
    );

  const timeIndex = getIndex("time", "date", "timestamp");
  const latIndex = getIndex("lat", "latitude");
  const lonIndex = getIndex("lon", "lng", "longitude");
  const altitudeIndex = getIndex("hMSL", "alt", "altitude", "height");
  const velNIndex = getIndex("velN", "vn", "north");
  const velEIndex = getIndex("velE", "ve", "east");
  const velDIndex = getIndex("velD", "vd", "down");

  if (
    timeIndex === -1 ||
    latIndex === -1 ||
    lonIndex === -1 ||
    altitudeIndex === -1 ||
    velNIndex === -1 ||
    velEIndex === -1 ||
    velDIndex === -1
  ) {
    return [];
  }

  return lines.slice(1).flatMap((line) => {
    const columns = line.split(delimiter);

    const lat = parseNumber(columns[latIndex]);
    const lon = parseNumber(columns[lonIndex]);
    const altitudeM = parseNumber(columns[altitudeIndex]);
    const velN = parseNumber(columns[velNIndex]);
    const velE = parseNumber(columns[velEIndex]);
    const velD = parseNumber(columns[velDIndex]);

    if (
      lat === null ||
      lon === null ||
      altitudeM === null ||
      velN === null ||
      velE === null ||
      velD === null
    ) {
      return [];
    }

    const horizontalSpeedMps = Math.sqrt(velN * velN + velE * velE);
    const verticalSpeedMps = velD;
    const totalSpeedMps = Math.sqrt(
      horizontalSpeedMps * horizontalSpeedMps +
        verticalSpeedMps * verticalSpeedMps
    );

    const glideRatio =
      verticalSpeedMps > 0 ? horizontalSpeedMps / verticalSpeedMps : null;

    const rawTime = columns[timeIndex] ?? "";

    const time = rawTime
      .trim()
      .replace(/^\uFEFF/, "")
      .replace(/^["']|["']$/g, "");

    const normalizedTime = time.replace(
      /\.(\d{1,2})Z$/,
      (_, fraction: string) => `.${fraction.padEnd(3, "0")}Z`
    );

    const parsedTimestampMs = Date.parse(normalizedTime);

    return [
      {
        time: normalizedTime,
        timestampMs: Number.isFinite(parsedTimestampMs)
          ? parsedTimestampMs
          : null,
        lat,
        lon,
        velNMps: velN,
        velEMps: velE,
        altitudeM,
        horizontalSpeedMps,
        verticalSpeedMps,
        totalSpeedMps,
        glideRatio,
      },
    ];
  });
}

function medianNumber(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function estimateDzElevationM(points: GpsTrackPoint[]) {
  const altitudes = points
    .map((point) => point.altitudeM)
    .filter((altitude) => Number.isFinite(altitude));

  if (altitudes.length === 0) {
    return null;
  }

  const tailSampleCount = Math.min(
    points.length,
    Math.round(120 / GPS_SAMPLE_PERIOD_SECONDS)
  );

  const tailPoints = points.slice(points.length - tailSampleCount);

  const landedAltitudes = tailPoints
    .filter(
      (point) =>
        point.horizontalSpeedMps <= 8 &&
        Math.abs(point.verticalSpeedMps) <= 3
    )
    .map((point) => point.altitudeM)
    .filter((altitude) => Number.isFinite(altitude));

  if (landedAltitudes.length >= 5) {
    return Math.round(medianNumber(landedAltitudes) ?? landedAltitudes[0]);
  }

  const sortedAltitudes = [...altitudes].sort((a, b) => a - b);
  const lowPercentileIndex = Math.min(
    sortedAltitudes.length - 1,
    Math.max(0, Math.floor(sortedAltitudes.length * 0.02))
  );

  return Math.round(sortedAltitudes[lowPercentileIndex]);
}

function distanceBetweenPointsM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) {
  const earthRadiusM = 6371000;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const deltaLatRad = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLonRad = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLonRad / 2) *
      Math.sin(deltaLonRad / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusM * c;
}

export function getScoringWindowResult(
  points: GpsTrackPoint[],
  windowOffsetM: number
) {
  const windowTopM = 2500 + windowOffsetM;
  const windowBottomM = 1500 + windowOffsetM;

  const startIndex = points.findIndex(
    (point, index) =>
      index > 0 &&
      points[index - 1].altitudeM > windowTopM &&
      point.altitudeM <= windowTopM
  );

  if (startIndex === -1) {
    return null;
  }

  const endIndex = points.findIndex(
    (point, index) =>
      index > startIndex &&
      points[index - 1].altitudeM > windowBottomM &&
      point.altitudeM <= windowBottomM
  );

  if (endIndex === -1) {
    return null;
  }

  const startBefore = points[startIndex - 1];
  const startAfter = points[startIndex];
  const endBefore = points[endIndex - 1];
  const endAfter = points[endIndex];

  const interpolateFraction = (
    altitudeBeforeM: number,
    altitudeAfterM: number,
    targetAltitudeM: number
  ) => {
    const altitudeChangeM = altitudeAfterM - altitudeBeforeM;

    if (altitudeChangeM === 0) {
      return 0;
    }

    return (targetAltitudeM - altitudeBeforeM) / altitudeChangeM;
  };

  const startFraction = interpolateFraction(
    startBefore.altitudeM,
    startAfter.altitudeM,
    windowTopM
  );

  const endFraction = interpolateFraction(
    endBefore.altitudeM,
    endAfter.altitudeM,
    windowBottomM
  );

  const interpolateValue = (before: number, after: number, fraction: number) =>
    before + (after - before) * fraction;

  const entryLat = interpolateValue(startBefore.lat, startAfter.lat, startFraction);
  const entryLon = interpolateValue(startBefore.lon, startAfter.lon, startFraction);
  const exitLat = interpolateValue(endBefore.lat, endAfter.lat, endFraction);
  const exitLon = interpolateValue(endBefore.lon, endAfter.lon, endFraction);

  const elapsedSamples =
    endIndex - startIndex + endFraction - startFraction;

  const timeSeconds = elapsedSamples * GPS_SAMPLE_PERIOD_SECONDS;

  const distanceM = distanceBetweenPointsM(entryLat, entryLon, exitLat, exitLon);

  return {
    timeSeconds,
    distanceM,
    entryLat,
    entryLon,
    exitLat,
    exitLon,
    startIndex,
    endIndex,
    startFraction,
    endFraction,
  };
}

export function getValidationStartPoint(points: GpsTrackPoint[]) {
  const validationOffsetSamples = Math.round(9 / GPS_SAMPLE_PERIOD_SECONDS);

  return points[Math.min(validationOffsetSamples, points.length - 1)] ?? null;
}

export function getWindowTrackPoints(
  points: GpsTrackPoint[],
  windowOffsetM: number
) {
  const windowTopM = 2500 + windowOffsetM;
  const windowBottomM = 1500 + windowOffsetM;

  const windowStartIndex = points.findIndex(
    (point, index) =>
      index > 0 &&
      points[index - 1].altitudeM > windowTopM &&
      point.altitudeM <= windowTopM
  );

  if (windowStartIndex === -1) {
    return [];
  }

  const windowEndOffset = points
    .slice(windowStartIndex + 1)
    .findIndex(
      (point, index) =>
        points[windowStartIndex + index].altitudeM > windowBottomM &&
        point.altitudeM <= windowBottomM
    );

  if (windowEndOffset === -1) {
    return [];
  }

  const windowEndIndex = windowStartIndex + 1 + windowEndOffset;

  return points.slice(windowStartIndex, windowEndIndex + 1);
}

export function getLast800mWindowPoints(points: GpsTrackPoint[]) {
  return points.filter(
    (point) => point.altitudeM <= 2300 && point.altitudeM >= 1500
  );
}

export function getTrackDistanceM(points: GpsTrackPoint[]) {
  if (points.length < 2) {
    return 0;
  }

  return points.slice(1).reduce((total, point, index) => {
    const previousPoint = points[index];

    return (
      total +
      distanceBetweenPointsM(
        previousPoint.lat,
        previousPoint.lon,
        point.lat,
        point.lon
      )
    );
  }, 0);
}

function kmhToMetresPerSecond(value: number) {
  return value / 3.6;
}

function findDetectedExitIndex(points: GpsTrackPoint[]) {
  const triggerMps = kmhToMetresPerSecond(EXIT_VERTICAL_SPEED_TRIGGER_KMH);

  const confirmationSeconds = 10;
  const confirmationSamples = Math.round(
    confirmationSeconds / GPS_SAMPLE_PERIOD_SECONDS
  );

  const baselineSeconds = 1.5;
  const baselineSamples = Math.round(
    baselineSeconds / GPS_SAMPLE_PERIOD_SECONDS
  );

  const transitionSeconds = 1;
  const transitionSamples = Math.round(
    transitionSeconds / GPS_SAMPLE_PERIOD_SECONDS
  );

  const getDiveAngleDeg = (point: GpsTrackPoint) =>
    Math.atan2(
      point.verticalSpeedMps,
      Math.max(point.horizontalSpeedMps, 0.01)
    ) *
    (180 / Math.PI);

  for (
    let index = baselineSamples;
    index < points.length - Math.max(confirmationSamples, transitionSamples);
    index += 1
  ) {
    const exitCandidate = points[index];

    const baselinePoints = points.slice(index - baselineSamples, index);

    const transitionPoints = points.slice(
      index,
      index + transitionSamples + 1
    );

    const confirmationPoints = points.slice(
      index,
      index + confirmationSamples + 1
    );

    const baselineVerticalSpeedMps =
      baselinePoints.reduce(
        (total, point) => total + point.verticalSpeedMps,
        0
      ) / baselinePoints.length;

    const finalConfirmationPoint =
      confirmationPoints[confirmationPoints.length - 1];

    const altitudeLossM =
      exitCandidate.altitudeM - finalConfirmationPoint.altitudeM;

    const peakVerticalSpeedMps = Math.max(
      ...confirmationPoints.map((point) => point.verticalSpeedMps)
    );

    const descendingPointRatio =
      confirmationPoints.filter((point) => point.verticalSpeedMps > triggerMps)
        .length / confirmationPoints.length;

    const acceleratedFromAircraft =
      peakVerticalSpeedMps >= baselineVerticalSpeedMps + 7;

    const reachedJumpVerticalSpeed = peakVerticalSpeedMps >= 12;

    const accelerationExitDetected =
      altitudeLossM >= EXIT_CONFIRMATION_ALTITUDE_LOSS_M &&
      descendingPointRatio >= 0.6 &&
      acceleratedFromAircraft &&
      reachedJumpVerticalSpeed;

    const baselineGlideRatio = medianNumber(
      baselinePoints
        .map((point) => point.glideRatio)
        .filter(
          (value): value is number =>
            value !== null && Number.isFinite(value) && value > 0
        )
    );

    const transitionGlideRatio = medianNumber(
      transitionPoints
        .map((point) => point.glideRatio)
        .filter(
          (value): value is number =>
            value !== null && Number.isFinite(value) && value > 0
        )
    );

    const baselineDiveAngleDeg = medianNumber(
      baselinePoints.map(getDiveAngleDeg)
    );

    const transitionDiveAngleDeg = medianNumber(
      transitionPoints.map(getDiveAngleDeg)
    );

    const glideRatioDrop =
      baselineGlideRatio !== null && transitionGlideRatio !== null
        ? baselineGlideRatio - transitionGlideRatio
        : 0;

    const glideRatioDropRatio =
      baselineGlideRatio !== null &&
      transitionGlideRatio !== null &&
      baselineGlideRatio > 0
        ? transitionGlideRatio / baselineGlideRatio
        : 1;

    const diveAngleIncreaseDeg =
      baselineDiveAngleDeg !== null && transitionDiveAngleDeg !== null
        ? transitionDiveAngleDeg - baselineDiveAngleDeg
        : 0;

    const aerodynamicExitDetected =
      baselineGlideRatio !== null &&
      transitionGlideRatio !== null &&
      baselineGlideRatio >= 8 &&
      glideRatioDrop >= 5 &&
      glideRatioDropRatio <= 0.55 &&
      diveAngleIncreaseDeg >= 5 &&
      exitCandidate.horizontalSpeedMps >= 20 &&
      altitudeLossM >= EXIT_CONFIRMATION_ALTITUDE_LOSS_M &&
      descendingPointRatio >= 0.5;

    if (accelerationExitDetected || aerodynamicExitDetected) {
      return index;
    }
  }

  return -1;
}

function refineExitByGlideRatio(
  points: GpsTrackPoint[],
  roughExitIndex: number
) {
  const searchSeconds = 15;
  const searchSamples = Math.round(searchSeconds / GPS_SAMPLE_PERIOD_SECONDS);

  const baselineSamples = Math.round(1 / GPS_SAMPLE_PERIOD_SECONDS);
  const transitionSamples = Math.round(0.8 / GPS_SAMPLE_PERIOD_SECONDS);

  const searchEndIndex = Math.min(
    points.length - transitionSamples - 1,
    roughExitIndex + searchSamples
  );

  for (
    let index = Math.max(roughExitIndex, baselineSamples);
    index <= searchEndIndex;
    index += 1
  ) {
    const beforePoints = points.slice(index - baselineSamples, index);

    const afterPoints = points.slice(index, index + transitionSamples + 1);

    const beforeRatios = beforePoints
      .map((point) => point.glideRatio)
      .filter(
        (value): value is number =>
          value !== null && Number.isFinite(value) && value > 0
      );

    const afterRatios = afterPoints
      .map((point) => point.glideRatio)
      .filter(
        (value): value is number =>
          value !== null && Number.isFinite(value) && value > 0
      );

    if (beforeRatios.length === 0 || afterRatios.length === 0) {
      continue;
    }

    const beforeGlideRatio =
      beforeRatios.reduce((sum, value) => sum + value, 0) /
      beforeRatios.length;

    const afterGlideRatio =
      afterRatios.reduce((sum, value) => sum + value, 0) / afterRatios.length;

    const beforeDiveAngle =
      beforePoints.reduce(
        (sum, point) =>
          sum +
          Math.atan2(
            point.verticalSpeedMps,
            Math.max(point.horizontalSpeedMps, 0.01)
          ) *
            (180 / Math.PI),
        0
      ) / beforePoints.length;

    const afterDiveAngle =
      afterPoints.reduce(
        (sum, point) =>
          sum +
          Math.atan2(
            point.verticalSpeedMps,
            Math.max(point.horizontalSpeedMps, 0.01)
          ) *
            (180 / Math.PI),
        0
      ) / afterPoints.length;

    const glideRatioCollapsed =
      beforeGlideRatio >= 8 &&
      afterGlideRatio <= beforeGlideRatio * 0.5 &&
      beforeGlideRatio - afterGlideRatio >= 5;

    const diveAngleIncreased = afterDiveAngle - beforeDiveAngle >= 5;

    if (glideRatioCollapsed && diveAngleIncreased) {
      return index;
    }
  }

  return roughExitIndex;
}

export function getPointDiveAngleDeg(point: GpsTrackPoint) {
  if (point.horizontalSpeedMps <= 0) {
    return 0;
  }

  return (
    Math.atan2(Math.max(point.verticalSpeedMps, 0), point.horizontalSpeedMps) *
    (180 / Math.PI)
  );
}

function findCompetitionDiveStartIndex(
  points: GpsTrackPoint[],
  aircraftExitIndex: number,
  dzElevationM: number
) {
  const aircraftExitAltitudeAglM =
    points[aircraftExitIndex].altitudeM - dzElevationM;

  if (aircraftExitAltitudeAglM <= COMPETITION_MAX_EXIT_ALTITUDE_M) {
    return aircraftExitIndex;
  }

  const firstEligibleIndex = points.findIndex(
    (point, index) =>
      index >= aircraftExitIndex &&
      point.altitudeM - dzElevationM <= COMPETITION_MAX_EXIT_ALTITUDE_M
  );

  if (firstEligibleIndex === -1) {
    return aircraftExitIndex;
  }

  const maxLookbackSamples = Math.round(
    COMPETITION_DIVE_MAX_LOOKBACK_SECONDS / GPS_SAMPLE_PERIOD_SECONDS
  );

  for (let index = aircraftExitIndex + 1; index < points.length; index += 1) {
    const currentAltitudeAglM = points[index].altitudeM - dzElevationM;

    if (currentAltitudeAglM > COMPETITION_MAX_EXIT_ALTITUDE_M) {
      continue;
    }

    const previousAngleDeg = getPointDiveAngleDeg(points[index - 1]);
    const currentAngleDeg = getPointDiveAngleDeg(points[index]);

    const crossedDiveTrigger =
      previousAngleDeg < COMPETITION_DIVE_TRIGGER_DEG &&
      currentAngleDeg >= COMPETITION_DIVE_TRIGGER_DEG;

    if (!crossedDiveTrigger) {
      continue;
    }

    let diveStartIndex = index;
    const earliestLookbackIndex = Math.max(
      aircraftExitIndex,
      index - maxLookbackSamples
    );

    while (diveStartIndex > earliestLookbackIndex) {
      const earlierAngleDeg = getPointDiveAngleDeg(points[diveStartIndex - 1]);
      const laterAngleDeg = getPointDiveAngleDeg(points[diveStartIndex]);

      const stillIncreasing =
        earlierAngleDeg <=
        laterAngleDeg + COMPETITION_DIVE_ANGLE_TOLERANCE_DEG;

      if (!stillIncreasing) {
        break;
      }

      diveStartIndex -= 1;
    }

    const eligibleDiveStartIndex = Math.max(firstEligibleIndex, diveStartIndex);

    const sampleCount = index - eligibleDiveStartIndex;
    const angleIncreaseDeg =
      currentAngleDeg - getPointDiveAngleDeg(points[eligibleDiveStartIndex]);

    const sustainedDive =
      sampleCount >= COMPETITION_DIVE_MIN_SAMPLES &&
      angleIncreaseDeg >= COMPETITION_DIVE_MIN_RISE_DEG;

    if (sustainedDive) {
      return eligibleDiveStartIndex;
    }
  }

  return aircraftExitIndex;
}

export function getValidatedJumpTrack(
  points: GpsTrackPoint[],
  dzElevationM = 0
) {
  const roughAircraftExitIndex = findDetectedExitIndex(points);

  if (roughAircraftExitIndex === -1) {
    return {
      isValidJump: false,
      exitPoint: null,
      aircraftExitPoint: null,
      jumpPoints: [],
    };
  }

  const aircraftExitIndex = refineExitByGlideRatio(
    points,
    roughAircraftExitIndex
  );

  const effectiveExitIndex = findCompetitionDiveStartIndex(
    points,
    aircraftExitIndex,
    dzElevationM
  );

  return {
    isValidJump: true,
    exitPoint: points[effectiveExitIndex],
    aircraftExitPoint: points[aircraftExitIndex],
    jumpPoints: points.slice(effectiveExitIndex),
  };
}

export function trimTrackAfterLanding(points: GpsTrackPoint[]) {
  const minimumFlightSeconds = 60;
  const minimumFlightSamples = Math.round(
    minimumFlightSeconds / GPS_SAMPLE_PERIOD_SECONDS
  );

  const landingConfirmationSeconds = 10;
  const landingConfirmationSamples = Math.round(
    landingConfirmationSeconds / GPS_SAMPLE_PERIOD_SECONDS
  );

  for (
    let index = minimumFlightSamples;
    index < points.length - landingConfirmationSamples;
    index += 1
  ) {
    const confirmationPoints = points.slice(
      index,
      index + landingConfirmationSamples
    );

    const slowPointRatio =
      confirmationPoints.filter(
        (point) =>
          point.horizontalSpeedMps < 3 && Math.abs(point.verticalSpeedMps) < 2
      ).length / confirmationPoints.length;

    if (slowPointRatio >= 0.9) {
      return points.slice(0, index);
    }
  }

  return points;
}

export function getTop100mFlareResult(
  points: GpsTrackPoint[],
  timeInWindowSeconds: number
) {
  if (timeInWindowSeconds <= 30) {
    return null;
  }

  const flareStartIndex = points.findIndex(
    (point) =>
      point.altitudeM <= 2550 &&
      point.altitudeM >= 2400 &&
      point.glideRatio !== null &&
      point.glideRatio >= 3
  );

  if (flareStartIndex === -1) {
    return null;
  }

  const flareStartPoint = points[flareStartIndex];
  const targetAltitudeM = flareStartPoint.altitudeM - 100;

  const flareEndOffset = points
    .slice(flareStartIndex)
    .findIndex((point) => point.altitudeM <= targetAltitudeM);

  if (flareEndOffset === -1) {
    return null;
  }

  const flareEndIndex = flareStartIndex + flareEndOffset;
  const flarePoints = points.slice(flareStartIndex, flareEndIndex + 1);

  const flareTimeSeconds =
    (flarePoints.length - 1) * GPS_SAMPLE_PERIOD_SECONDS;
  const flareDistanceM = getTrackDistanceM(flarePoints);
  const peakFlareAltitudeM = Math.max(
    ...flarePoints.map((point) => point.altitudeM)
  );

  const altitudeGainM = Math.max(
    0,
    peakFlareAltitudeM - flareStartPoint.altitudeM
  );

  return {
    startAltitudeM: flareStartPoint.altitudeM,
    altitudeGainM,
    endAltitudeM: points[flareEndIndex].altitudeM,
    timeSeconds: flareTimeSeconds,
    distanceM: flareDistanceM,
  };
}

export function metresPerSecondToKmh(value: number) {
  return value * 3.6;
}

export function formatNumber(value: number | null | undefined, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "â€”";
  }

  return value.toFixed(decimals);
}
