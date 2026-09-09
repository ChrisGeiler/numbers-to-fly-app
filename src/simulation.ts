import type { GpsTrackPoint } from './gpsAnalysis';

export type SimulationFirmwareProfile = 'standard' | 'window-audio';
export type SimulationFirmwareState =
  | 'pre-flight'
  | 'flight-confirmed'
  | 'window-entered'
  | 'post-window-audio';

const WINDOW_AUDIO_FIRMWARE_COMMITS = ['g8ae5110', 'g16ab9db'];
const WINDOW_AUDIO_SIMULATOR_EMAIL = 'starcruza@hotmail.com';
const FLIGHT_DESCENT_MIN_SPEED_MPS = 20;
const FLIGHT_DESCENT_CONFIRM_SECONDS = 1;
const FLARE_CLIMB_MIN_SPEED_MPS = -3;
const FLARE_MIN_GAIN_M = 5;
const FLARE_ARM_DEPTH_M = 250;

export function readSimulationConfig(text: string) {
  const values: Record<string, number> = {};
  const alarms: { elevation: number; type: number; file: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\w+):\s*([^;]+)/);
    if (!match) continue;
    const [, key, raw] = match;
    if (key === 'Alarm_Elev') alarms.push({ elevation: Number(raw), type: 0, file: '' });
    else if (key === 'Alarm_Type' && alarms.length) alarms[alarms.length - 1].type = Number(raw);
    else if (key === 'Alarm_File' && alarms.length) alarms[alarms.length - 1].file = raw.trim();
    else values[key] = Number(raw);
  }
  return { values, alarms };
}

export function simulationValue(point: GpsTrackPoint, mode: number) {
  if (mode === 2) return point.verticalSpeedMps === 0 ? null : point.horizontalSpeedMps / point.verticalSpeedMps * 100;
  return (mode === 1 ? point.verticalSpeedMps : point.horizontalSpeedMps) * 100;
}

// FlySight audio_control.c: suppression does not reset the speech counter.
export function simulationSuppressed(altitude: number, config: ReturnType<typeof readSimulationConfig>) {
  const { values: v, alarms } = config;
  return (altitude >= v.Win_Bottom && altitude <= v.Win_Top) ||
    alarms.some(a => altitude >= a.elevation - v.Win_Below && altitude <= a.elevation + v.Win_Above);
}

export function detectSimulationFirmware(flysightText: string) {
  const version = flysightText.match(/^\s*Firmware_Ver:\s*([^;\r\n]+)/mi)?.[1].trim() ?? null;
  return {
    version,
    profile: WINDOW_AUDIO_FIRMWARE_COMMITS.some(commit => version?.includes(commit))
      ? 'window-audio' as const
      : 'standard' as const,
  };
}

export function canUseWindowAudioFirmware(email?: string | null) {
  return email?.trim().toLowerCase() === WINDOW_AUDIO_SIMULATOR_EMAIL;
}

export function simulationAlarmShouldWait(
  profile: SimulationFirmwareProfile,
  state: SimulationFirmwareState | undefined,
  speechActive: boolean,
) {
  return profile === 'window-audio' &&
    state === 'post-window-audio' &&
    speechActive;
}

export function simulationFirmwareTimeline(
  points: Array<GpsTrackPoint & { seconds: number }>,
  groundElevation: number,
  config: ReturnType<typeof readSimulationConfig>,
  profile: SimulationFirmwareProfile,
) {
  let state: SimulationFirmwareState = 'pre-flight';
  let descentSeconds = 0;
  let previousRawSuppression = false;
  let previousAltitude = 0;
  let hasPreviousFix = false;
  let windowEntryAltitude = 0;
  let windowMinimumAltitude = Number.POSITIVE_INFINITY;
  const configuredIntervalSeconds = Number.isFinite(config.values.Rate)
    ? Math.max(0, config.values.Rate) / 1000
    : 0;

  return points.map((point, index) => {
    const rawSuppression = simulationSuppressed(
      point.altitudeM - groundElevation,
      config,
    );

    if (profile === 'window-audio') {
      if (state === 'pre-flight') {
        if (
          point.verticalSpeedMps >= FLIGHT_DESCENT_MIN_SPEED_MPS &&
          point.vAccM !== null &&
          point.vAccM !== undefined &&
          point.vAccM < 10
        ) {
          const recordedIntervalSeconds = index > 0
            ? Math.max(0, point.seconds - points[index - 1].seconds)
            : 0;
          descentSeconds = Math.min(
            FLIGHT_DESCENT_CONFIRM_SECONDS,
            descentSeconds + (configuredIntervalSeconds || recordedIntervalSeconds),
          );
          if (descentSeconds >= FLIGHT_DESCENT_CONFIRM_SECONDS) {
            state = 'flight-confirmed';
          }
        } else {
          descentSeconds = 0;
        }
      }

      if (hasPreviousFix) {
        if (
          state === 'flight-confirmed' &&
          previousRawSuppression &&
          !rawSuppression &&
          point.verticalSpeedMps > 0
        ) {
          state = 'window-entered';
          windowEntryAltitude = previousAltitude;
          windowMinimumAltitude = point.altitudeM;
        } else if (state === 'window-entered') {
          windowMinimumAltitude = Math.min(windowMinimumAltitude, point.altitudeM);
          if (
            rawSuppression &&
            point.verticalSpeedMps <= FLARE_CLIMB_MIN_SPEED_MPS &&
            point.altitudeM - windowMinimumAltitude >= FLARE_MIN_GAIN_M &&
            point.altitudeM >= windowEntryAltitude - FLARE_ARM_DEPTH_M
          ) {
            state = 'post-window-audio';
          }
        }
      }
    }

    previousRawSuppression = rawSuppression;
    previousAltitude = point.altitudeM;
    hasPreviousFix = true;

    return {
      rawSuppression,
      suppressed: profile === 'window-audio' && state === 'post-window-audio'
        ? false
        : rawSuppression,
      state,
    };
  });
}

export function simulationSpeechDue(now: number, next: number, rate: number, suppressed: boolean, threshold: boolean, busy: boolean) {
  return rate > 0 && now >= next && !suppressed && threshold && !busy;
}

export function simulationSpeechNumber(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return (Math.trunc(value * scale) / scale).toFixed(decimals);
}

export function simulationTone(value: number, older: number, elapsed: number, v: Record<string, number>) {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const pitch = 220 + Math.trunc(1540 * clamp((value - v.Min) / (v.Max - v.Min)));
  const change = elapsed > 0 ? 10000 * Math.abs((older - value) / elapsed) / Math.abs(v.Max - v.Min) : 0;
  const rate = (v.Min_Rate + clamp((change - v.Min_Val_2) / (v.Max_Val_2 - v.Min_Val_2)) * (v.Max_Rate - v.Min_Rate)) / 100;
  return { pitch, rate };
}

export function simulationTimeline(points: GpsTrackPoint[]) {
  const valid = points.filter(p => p.timestampMs !== null && Number.isFinite(p.timestampMs));
  let last = -Infinity;
  return valid.filter(p => {
    if (p.timestampMs! <= last) return false;
    last = p.timestampMs!;
    return true;
  })
    .map(p => ({ ...p, seconds: (p.timestampMs! - valid[0].timestampMs!) / 1000 }));
}

export function simulationWindow(points: GpsTrackPoint[], groundElevation: number) {
  const top = groundElevation + 3353;
  const bottom = groundElevation + 1500;
  function crossing(a: GpsTrackPoint, b: GpsTrackPoint, altitude: number): GpsTrackPoint {
    const fraction = (altitude - a.altitudeM) / (b.altitudeM - a.altitudeM);
    const result = { ...b, altitudeM: altitude };
    for (const key of ['lat', 'lon', 'velNMps', 'velEMps', 'horizontalSpeedMps', 'verticalSpeedMps', 'totalSpeedMps'] as const) {
      result[key] = a[key] + (b[key] - a[key]) * fraction;
    }
    result.glideRatio = a.glideRatio !== null && b.glideRatio !== null ? a.glideRatio + (b.glideRatio - a.glideRatio) * fraction : null;
    result.timestampMs = a.timestampMs !== null && b.timestampMs !== null ? a.timestampMs + (b.timestampMs - a.timestampMs) * fraction : null;
    return result;
  }
  const start = points.findIndex(p => p.altitudeM <= top);
  if (start < 0 || points[start].altitudeM < bottom) return [];
  const clipped: GpsTrackPoint[] = [];
  if (start > 0 && points[start].altitudeM < top) clipped.push(crossing(points[start - 1], points[start], top));
  for (let i = start; i < points.length; i++) {
    if (points[i].altitudeM < bottom) {
      if (i > 0 && points[i - 1].altitudeM > bottom) clipped.push(crossing(points[i - 1], points[i], bottom));
      break;
    }
    clipped.push(points[i]);
    if (points[i].altitudeM === bottom) break;
  }
  return simulationTimeline(clipped);
}
