export type MeasurementPoint = {
  timeSeconds: number;
  altitudeM: number;
  horizontalSpeedKmh: number;
  verticalSpeedKmh: number;
  totalSpeedKmh: number;
  calculatedAirspeedKmh: number;
  glideRatio: number | null;
  diveAngleDeg: number;
};

// Keep the requested metrics in the flight graph tooltip's default name order.
export const measurementMetrics = [
  { key: 'calculatedAirspeedKmh', label: 'Corrected speed', unit: ' km/h', digits: 1 },
  { key: 'diveAngleDeg', label: 'Dive angle', unit: '°', digits: 1 },
  { key: 'glideRatio', label: 'GR', unit: '', digits: 2 },
  { key: 'horizontalSpeedKmh', label: 'Horizontal speed', unit: ' km/h', digits: 1 },
  { key: 'totalSpeedKmh', label: 'Total speed', unit: ' km/h', digits: 1 },
  { key: 'verticalSpeedKmh', label: 'Vertical speed', unit: ' km/h', digits: 1 },
] as const;

export function measureChartRange(points: MeasurementPoint[], from: number, to: number) {
  const start = Math.max(Math.min(from, to), points[0]?.timeSeconds ?? 0);
  const end = Math.min(Math.max(from, to), points.at(-1)?.timeSeconds ?? 0);
  if (end <= start) return null;
  const totals = Object.fromEntries(measurementMetrics.map(({ key }) => [key, { area: 0, duration: 0 }]));
  let startAltitude: number | null = null;
  let endAltitude: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const left = Math.max(start, a.timeSeconds), right = Math.min(end, b.timeSeconds);
    if (right <= left || b.timeSeconds <= a.timeSeconds) continue;
    const interpolate = (x: number, y: number, time: number) => x + (y - x) * (time - a.timeSeconds) / (b.timeSeconds - a.timeSeconds);
    startAltitude ??= interpolate(a.altitudeM, b.altitudeM, left);
    endAltitude = interpolate(a.altitudeM, b.altitudeM, right);
    for (const { key } of measurementMetrics) {
      const x = a[key], y = b[key];
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      totals[key].area += (interpolate(x, y, left) + interpolate(x, y, right)) / 2 * (right - left);
      totals[key].duration += right - left;
    }
  }
  if (startAltitude === null || endAltitude === null) return null;
  return {
    start, end, altitudeChangeM: endAltitude - startAltitude,
    averages: measurementMetrics.map(metric => ({ ...metric, value: totals[metric.key].duration > 0 ? totals[metric.key].area / totals[metric.key].duration : null })),
  };
}
