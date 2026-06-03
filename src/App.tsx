import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

type AppPage = "landing" | "find" | "fly" | "config" | "lane";
type TaskMode = "time" | "distance" | "speed";
type WindSource = "manual" | "mark-schulze" | "open-meteo" | "windy";
type SuitSetup =
  | "crplus-no-wingtips"
  | "crplus-wingtips"
  | "freak-atc"
  | "swift";
type UnitSystem = "metric" | "imperial";
type FlySightVersion = "original" | "flysight2";
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

type LatLon = {
  lat: number;
  lon: number;
};

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

const defaultWinds: WindLayer[] = altitudes.map((altitudeM) => ({
  altitudeM,
  directionFromDeg: "",
  speedKt: "",
}));

const tailHeadDeadbandKt = 2;
const markSchulzeProxyUrl =
  "https://numbers-to-fly-winds.flywithcruza.workers.dev";

const referencePointIcon = L.divIcon({
  className: "reference-point-marker",
  html: "<div></div>",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

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

  // Find your Numbers currently combines Freak / ATC.
  // Default to Freak for Config your Numbers.
  return "freak";
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
Min:       ${minValue}     ; Lowest pitch value
                 ;   cm/s        in Mode 0, 1, or 4
                 ;   ratio * 100 in Mode 2 or 3
                 ;   degrees     in Mode 11
Max:       ${maxValue}     ; Highest pitch value
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

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeLongitude(lonDeg: number): number {
  return ((lonDeg + 540) % 360) - 180;
}

function signedAngleDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function kmhToKt(speedKmh: number): number {
  return speedKmh / 1.852;
}

function nmToMetres(distanceNm: number): number {
  return distanceNm * 1852;
}

function destinationPoint(
  startLatDeg: number,
  startLonDeg: number,
  bearingDeg: number,
  distanceM: number
): LatLon {
  const earthRadiusM = 6371000;
  const angularDistance = distanceM / earthRadiusM;

  const bearingRad = degToRad(bearingDeg);
  const startLatRad = degToRad(startLatDeg);
  const startLonRad = degToRad(startLonDeg);

  const endLatRad = Math.asin(
    Math.sin(startLatRad) * Math.cos(angularDistance) +
      Math.cos(startLatRad) * Math.sin(angularDistance) * Math.cos(bearingRad)
  );

  const endLonRad =
    startLonRad +
    Math.atan2(
      Math.sin(bearingRad) *
        Math.sin(angularDistance) *
        Math.cos(startLatRad),
      Math.cos(angularDistance) - Math.sin(startLatRad) * Math.sin(endLatRad)
    );

  return {
    lat: radToDeg(endLatRad),
    lon: normalizeLongitude(radToDeg(endLonRad)),
  };
}

function calculateDropPoint(
  referenceLat: number,
  referenceLon: number,
  runHeadingDeg: number,
  dropDistanceNm: number
): LatLon {
  const backBearing = normalizeDeg(runHeadingDeg + 180);

  return destinationPoint(
    referenceLat,
    referenceLon,
    backBearing,
    nmToMetres(dropDistanceNm)
  );
}

function buildLanePolygon(
  startPoint: LatLon,
  endPoint: LatLon,
  runHeadingDeg: number,
  halfWidthM: number
): [number, number][] {
  const leftBearing = normalizeDeg(runHeadingDeg - 90);
  const rightBearing = normalizeDeg(runHeadingDeg + 90);

  const startLeft = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    leftBearing,
    halfWidthM
  );

  const endLeft = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    leftBearing,
    halfWidthM
  );

  const endRight = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    rightBearing,
    halfWidthM
  );

  const startRight = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    rightBearing,
    halfWidthM
  );

  return [
    [startLeft.lat, startLeft.lon],
    [endLeft.lat, endLeft.lon],
    [endRight.lat, endRight.lon],
    [startRight.lat, startRight.lon],
  ];
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

function getOpenMeteoHourlyIndex(data: OpenMeteoResponse): number {
  const times = data.hourly?.time;

  if (!times || times.length === 0) {
    return 0;
  }

  const now = new Date();
  let closestIndex = 0;
  let closestDifferenceMs = Infinity;

  times.forEach((time, index) => {
    const forecastTime = new Date(time);
    const differenceMs = Math.abs(forecastTime.getTime() - now.getTime());

    if (differenceMs < closestDifferenceMs) {
      closestDifferenceMs = differenceMs;
      closestIndex = index;
    }
  });

  return closestIndex;
}

function mapOpenMeteoToWindLayers(data: OpenMeteoResponse): WindLayer[] {
  const hourly = data.hourly;

  if (!hourly) {
    throw new Error("Open-Meteo response did not include hourly data.");
  }

  const index = getOpenMeteoHourlyIndex(data);

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
}: {
  referenceLat: string;
  referenceLon: string;
  userMapLocation: LatLon | null;
}) {
  const map = useMap();

  useEffect(() => {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat !== null && lon !== null) {
      map.setView([lat, lon], 12);
      return;
    }

    if (userMapLocation !== null) {
      map.setView([userMapLocation.lat, userMapLocation.lon], 13);
    }
  }, [map, referenceLat, referenceLon, userMapLocation]);

  return null;
}

function MapClickPicker({
  referenceLat,
  referenceLon,
  userMapLocation,
  dropPoint,
  flightLineColor,
  runHeadingDeg,
  showTemporaryFlightLine, 
  onPick,
}: {
  referenceLat: string;
  referenceLon: string;
  userMapLocation: LatLon | null;
  dropPoint: LatLon | null;
  flightLineColor: string;
  runHeadingDeg: string;
  showTemporaryFlightLine: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  const lat = optionalNumberFromInput(referenceLat);
  const lon = optionalNumberFromInput(referenceLon);

  const hasReferencePoint = lat !== null && lon !== null;
  const hasUserMapLocation = userMapLocation !== null;

  const center: [number, number] = hasReferencePoint
    ? [lat, lon]
    : hasUserMapLocation
      ? [userMapLocation.lat, userMapLocation.lon]
      : [20, 0];

  const initialZoom = hasReferencePoint ? 12 : hasUserMapLocation ? 13 : 2;

  function ClickHandler() {
    useMapEvents({
      click(event) {
        onPick(event.latlng.lat, event.latlng.lng);
      },
    });

    return null;
  }

  const linePositions =
    lat !== null && lon !== null && dropPoint !== null
      ? [
          [dropPoint.lat, dropPoint.lon] as [number, number],
          [lat, lon] as [number, number],
        ]
      : [];

  const headingNumber = optionalNumberFromInput(runHeadingDeg);

  const hasLaneGeometry =
    lat !== null &&
    lon !== null &&
    dropPoint !== null &&
    headingNumber !== null;

  const redLanePolygon = hasLaneGeometry
  ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 600)
  : [];

  const yellowLanePolygon = hasLaneGeometry
    ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 450)
    : [];

  const greenLanePolygon = hasLaneGeometry
    ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 300)
    : [];

  return (
    <div className="map-picker">
      <MapContainer center={center} zoom={initialZoom} scrollWheelZoom={true}>
        <MapViewportUpdater
          referenceLat={referenceLat}
          referenceLon={referenceLon}
          userMapLocation={userMapLocation}
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

        {redLanePolygon.length === 4 && (
          <Polygon
            positions={redLanePolygon}
            pathOptions={{
              color: "#ef4444",
              weight: 2,
              opacity: 0.85,
              fillColor: "#ef4444",
              fillOpacity: 0.18,
            }}
          />
        )}

        {yellowLanePolygon.length === 4 && (
          <Polygon
            positions={yellowLanePolygon}
            pathOptions={{
              color: "#facc15",
              weight: 2,
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
              color: "#22c55e",
              weight: 2,
              opacity: 0.95,
              fillColor: "#22c55e",
              fillOpacity: 0.26,
            }}
          />
        )}

        {dropPoint !== null && (
          <Marker
            position={[dropPoint.lat, dropPoint.lon]}
            icon={dropPointIcon}
          />
        )}

        {lat !== null && lon !== null && (
          <Marker position={[lat, lon]} icon={referencePointIcon} />
        )}

        {showTemporaryFlightLine && linePositions.length === 2 && (
          <Polyline
            positions={linePositions}
            pathOptions={{
              color: flightLineColor,
              weight: 5,
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
}: {
  referenceLat: string;
  referenceLon: string;
  dropPoint: LatLon | null;
  runHeadingDeg: string;
}) {
  const lat = optionalNumberFromInput(referenceLat);
  const lon = optionalNumberFromInput(referenceLon);
  const headingNumber = optionalNumberFromInput(runHeadingDeg);

  const hasLaneGeometry =
    lat !== null &&
    lon !== null &&
    dropPoint !== null &&
    headingNumber !== null;

  const center: [number, number] =
    hasLaneGeometry && dropPoint !== null
      ? [(lat + dropPoint.lat) / 2, (lon + dropPoint.lon) / 2]
      : lat !== null && lon !== null
        ? [lat, lon]
        : [20, 0];

  const outerLanePolygon = hasLaneGeometry
    ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 600)
    : [];

  const innerLanePolygon = hasLaneGeometry
    ? buildLanePolygon(dropPoint, { lat, lon }, headingNumber, 300)
    : [];

  const linePositions =
    hasLaneGeometry && dropPoint !== null
      ? [
          [dropPoint.lat, dropPoint.lon] as [number, number],
          [lat, lon] as [number, number],
        ]
      : [];

  return (
    <div className="lane-view-map">
      <MapContainer center={center} zoom={13} scrollWheelZoom={true}>
        <TileLayer
          attribution="Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />

        {outerLanePolygon.length === 4 && (
          <Polygon
            positions={outerLanePolygon}
            pathOptions={{
              color: "#f97316",
              weight: 2,
              opacity: 0.9,
              fillColor: "#f97316",
              fillOpacity: 0.16,
            }}
          />
        )}

        {innerLanePolygon.length === 4 && (
          <Polygon
            positions={innerLanePolygon}
            pathOptions={{
              color: "#22c55e",
              weight: 2,
              opacity: 0.95,
              fillColor: "#22c55e",
              fillOpacity: 0.24,
            }}
          />
        )}

        {linePositions.length === 2 && (
          <Polyline
            positions={linePositions}
            pathOptions={{
              color: "#38bdf8",
              weight: 4,
              opacity: 0.9,
            }}
          />
        )}

        {dropPoint !== null && (
          <Marker
            position={[dropPoint.lat, dropPoint.lon]}
            icon={dropPointIcon}
          />
        )}

        {lat !== null && lon !== null && (
          <Marker position={[lat, lon]} icon={referencePointIcon} />
        )}
      </MapContainer>
    </div>
  );
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

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>("landing");

  const [findUnitSystem, setFindUnitSystem] = useState<UnitSystem>("metric");
  const [findWeight, setFindWeight] = useState("");
  const [findHeightCm, setFindHeightCm] = useState("");
  const [findHeightFeet, setFindHeightFeet] = useState("");
  const [findHeightInches, setFindHeightInches] = useState("");
  const [findSuitSetup, setFindSuitSetup] =
    useState<SuitSetup>("crplus-no-wingtips");

  const [taskMode, setTaskMode] = useState<TaskMode>("distance");
  const [windSource, setWindSource] = useState<WindSource>("mark-schulze");

  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState("");
  const [startGR, setStartGR] = useState("");
  const [endGR, setEndGR] = useState("");

  const [savedDistanceSpeedKph, setSavedDistanceSpeedKph] = useState("");
  const [savedTimeSpeedKph, setSavedTimeSpeedKph] = useState("");

  const [runHeadingDeg, setRunHeadingDeg] = useState("");
  const [showTemporaryFlightLine, setShowTemporaryFlightLine] = useState(false);
  const [dropDistanceNm, setDropDistanceNm] = useState("");

  const [globalWindFromDeg, setGlobalWindFromDeg] = useState("");
  const [globalWindSpeedKt, setGlobalWindSpeedKt] = useState("");

  const [referenceLat, setReferenceLat] = useState("");
  const [referenceLon, setReferenceLon] = useState("");

  const [userMapLocation, setUserMapLocation] = useState<LatLon | null>(null);
  const [locationStatus, setLocationStatus] = useState("");

  const [fetchStatus, setFetchStatus] = useState("");
  const [referenceStatus, setReferenceStatus] = useState("");
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [showRawWinds, setShowRawWinds] = useState(false);
  const [winds, setWinds] = useState<WindLayer[]>(defaultWinds);

  const [configTask, setConfigTask] = useState<ConfigTask>("distance");
  const [configSuit, setConfigSuit] =
    useState<ConfigSuit>("crplus-no-wingtips");
  const [flySightVersion, setFlySightVersion] =
    useState<FlySightVersion>("original");
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
  const [copyStatus, setCopyStatus] = useState("");

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

    if (openingMap && userMapLocation === null) {
      requestUserMapLocation();
    }
  }

  function toggleFindUnitSystem() {
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

function pushAllFoundNumbersToFlyPage() {
  const distanceSpeed = String(foundNumbers.distanceSpeedKph);
  const timeSpeed = String(foundNumbers.timeSpeedKph);
  const speedStart = foundNumbers.speedStartGR.toFixed(2);
  const speedEnd = foundNumbers.speedEndGR.toFixed(2);

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

  setSavedDistanceSpeedKph(distanceSpeed);
  setSavedTimeSpeedKph(timeSpeed);

  setZeroWindSpeedKph(distanceSpeed);
  setStartGR(speedStart);
  setEndGR(speedEnd);

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

    const url = `${markSchulzeProxyUrl}/?lat=${encodeURIComponent(
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

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = (await response.json()) as OpenMeteoResponse;
    const importedWinds = mapOpenMeteoToWindLayers(data);

    setWinds(importedWinds);
    setFetchStatus("Loaded Open-Meteo forecast winds.");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error while fetching winds.";

    setFetchStatus(
      `Could not fetch Open-Meteo winds. ${message}. Use raw winds or try again later.`
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
      await fetchOpenMeteoWindsForLocation(lat, lon);
    }
  }

  async function pickReferenceFromMap(lat: number, lon: number) {
    await setReferencePoint(lat, lon, "map");
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
    await fetchOpenMeteoWindsForLocation(lat, lon);
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
        <LaneViewMap
          referenceLat={referenceLat}
          referenceLon={referenceLon}
          dropPoint={calculatedDropPoint}
          runHeadingDeg={runHeadingDeg}
        />
      </section>
    </main>
  );
}

  if (activePage === "landing") {
    return (
      <main className="app landing-page">
        <header className="app-header landing-header">
          <img
            className="app-logo landing-logo"
            src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
            alt="Numbers to Fly logo"
          />

          <p className="tagline">Know your numbers in the window.</p>

          <div className="landing-actions">
            <button type="button" onClick={() => setActivePage("find")}>
              Find the Numbers
            </button>

            <button type="button" onClick={() => setActivePage("fly")}>
              Fly the Numbers
            </button>

            <button type="button" onClick={() => setActivePage("config")}>
              Config the Numbers
            </button>
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

          <button
            type="button"
            className="primary-action-button"
            onClick={toggleFindUnitSystem}
          >
            {findUnitSystem === "metric"
              ? "Switch to Imperial"
              : "Switch to Metric"}
          </button>

          <div className="manual-wind-controls">
            <label>
              Weight, {findUnitSystem === "metric" ? "kg" : "lb"}
              <input
                type="number"
                value={findWeight}
                placeholder={
                  findUnitSystem === "metric" ? "Example 78" : "Example 175"
                }
                onChange={(e) => setFindWeight(e.target.value)}
              />
            </label>

            {findUnitSystem === "metric" ? (
              <label>
                Height, cm
                <input
                  type="number"
                  value={findHeightCm}
                  placeholder="Example 180"
                  onChange={(e) => setFindHeightCm(e.target.value)}
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
                    onChange={(e) => setFindHeightFeet(e.target.value)}
                  />
                </label>

                <label>
                  Height, inches
                  <input
                    type="number"
                    value={findHeightInches}
                    placeholder="Example 11"
                    onChange={(e) => setFindHeightInches(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          <label>
            Suit setup
            <select
              value={findSuitSetup}
              onChange={(e) => setFindSuitSetup(e.target.value as SuitSetup)}
            >
              <option value="crplus-no-wingtips">CR+ without wingtips</option>
              <option value="crplus-wingtips">CR+ with wingtips</option>
              <option value="freak-atc">Freak / ATC</option>
              <option value="swift">Swift</option>
            </select>
          </label>
        </section>

        <section className="card">
          <h2>Estimated Zero Wind Numbers</h2>

          <div className="numbers-grid">
            <div className="number-tile">
              <span>Distance speed</span>
              <strong>{foundNumbers.distanceSpeedKph} km/h</strong>
            </div>

            <div className="number-tile">
              <span>Time speed</span>
              <strong>{foundNumbers.timeSpeedKph} km/h</strong>
            </div>

            <div className="number-tile">
              <span>Speed start GR</span>
              <strong>{foundNumbers.speedStartGR.toFixed(2)}</strong>
            </div>

            <div className="number-tile">
              <span>Speed end GR</span>
              <strong>{foundNumbers.speedEndGR.toFixed(2)}</strong>
            </div>
          </div>

          <button
            type="button"
            className="primary-action-button"
            onClick={pushAllFoundNumbersToFlyPage}
          >
            Push all numbers to Fly your Numbers
          </button>

          <p className="calculator-disclaimer">
            Starting point only. Refine these numbers with actual training data,
            suit setup, FlySight data, and coaching feedback.
          </p>
        </section>
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
            Generate task-specific FlySight settings. Original FlySight users can
            copy/download the file and transfer by cable. FlySight 2 Bluetooth
            transfer can be added later.
          </p>

          <label>
            FlySight version
            <select
              value={flySightVersion}
              onChange={(e) =>
                setFlySightVersion(e.target.value as FlySightVersion)
              }
            >
              <option value="original">Original FlySight</option>
              <option value="flysight2">FlySight 2</option>
            </select>
          </label>

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
            it, the aircraft is too high and any record score may be void.
          </p>

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
            Keep the firmware header at the very top of the FlySight file, then
            paste the generated config directly underneath it.
          </p>

          <pre className="firmware-header">{`; Firmware version v20######

; For information on configuring FlySight, please go to
;     http://flysight.ca/wiki`}</pre>

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
            type="number"
            step="0.1"
            value={dropDistanceNm}
            placeholder="Example 3.0"
            onChange={(e) => setDropDistanceNm(e.target.value)}
          />
        </label>

        <h2>Reference Point</h2>

        <p className="subtitle">
          Choose the competition reference point on the map.
        </p>

        <button
          type="button"
          className="primary-action-button"
          onClick={toggleMapPicker}
        >
          {showMapPicker ? "Hide map" : "Choose reference point"}
        </button>

        {locationStatus && <p className="subtitle">{locationStatus}</p>}

        {showMapPicker && (
          <>
            <p className="subtitle">
              Tap the map to set the reference point. Green is within 7.5° of
              the best tailwind heading, orange is within 15°, and red is
              outside that range.
            </p>

            <MapClickPicker
              referenceLat={referenceLat}
              referenceLon={referenceLon}
              userMapLocation={userMapLocation}
              dropPoint={calculatedDropPoint}
              flightLineColor={windAdvantage.color}
              onPick={pickReferenceFromMap}
              runHeadingDeg={runHeadingDeg}
              showTemporaryFlightLine={showTemporaryFlightLine}
            />

            <button
              type="button"
              className="primary-action-button"
              onClick={() => setActivePage("lane")}
            >
              Zoom on my Lane
            </button>
            </>
        )}

        <HeadingSlider
          runHeadingDeg={runHeadingDeg}
          windAdvantage={windAdvantage}
          windSourceUnavailable={fetchStatus.includes("Could not fetch")}
          onInteractionStart={() => setShowTemporaryFlightLine(true)}
          onInteractionEnd={() => setShowTemporaryFlightLine(false)}
          onChange={updateHeadingFromSlider}
        />
        {calculatedDropPoint && (
          <p className="subtitle">
            Drop/start point: {calculatedDropPoint.lat.toFixed(6)},{" "}
            {calculatedDropPoint.lon.toFixed(6)}
          </p>
        )}

        {referenceStatus && <p className="subtitle">{referenceStatus}</p>}
      </section>

      <section className="card">
        <h2>Wind</h2>

        <label>
          Source
          <select
            value={windSource}
            onChange={(e) => handleWindSourceChange(e.target.value as WindSource)}
          >
            <option value="mark-schulze">Mark Schulze</option>
            <option value="open-meteo">Open-Meteo</option>
            <option value="manual">Manual</option>
            <option value="windy">Windy visual check</option>
          </select>
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