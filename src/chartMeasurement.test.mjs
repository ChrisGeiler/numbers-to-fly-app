import test from 'node:test';
import assert from 'node:assert/strict';
import { measureChartRange } from './chartMeasurement.ts';
const point = (timeSeconds, altitudeM, speed) => ({ timeSeconds, altitudeM, horizontalSpeedKmh: speed, verticalSpeedKmh: speed, totalSpeedKmh: speed * 2, calculatedAirspeedKmh: speed, glideRatio: speed, diveAngleDeg: speed });
test('weights uneven samples by elapsed time and supports backwards drags', () => {
  const points = [point(0, 1000, 0), point(1, 990, 10), point(4, 960, 10)];
  const result = measureChartRange(points, 4, 0);
  assert.equal(result.altitudeChangeM, -40);
  assert.equal(result.averages[0].value, 8.75);
  assert.equal(result.averages.find(m => m.key === "totalSpeedKmh").value, 17.5);
  assert.deepEqual(result, measureChartRange(points, 0, 4));
});
test('interpolates boundaries, retains ascent sign, and rejects empty selections', () => {
  const points = [point(0, 100, 0), point(10, 200, 100)];
  const result = measureChartRange(points, 2, 6);
  assert.equal(result.altitudeChangeM, 40);
  assert.equal(result.averages[0].value, 40);
  assert.equal(measureChartRange(points, 2, 2), null);
  assert.equal(measureChartRange([], 0, 10), null);
});
test('undefined glide ratio stays unavailable instead of becoming zero', () => {
  const points = [point(0, 100, 10), point(1, 90, 20)].map(p => ({ ...p, glideRatio: null }));
  assert.equal(measureChartRange(points, 0, 1).averages.find(m => m.key === 'glideRatio').value, null);
});
