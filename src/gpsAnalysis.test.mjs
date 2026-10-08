import test from 'node:test';
import assert from 'node:assert/strict';
import { getTop100mFlareResult } from './gpsAnalysis.ts';

function flare(samples) {
  return getTop100mFlareResult(samples.map(([altitudeM, verticalSpeedMps], i) => ({
    time: String(i), timestampMs: i * 200, lat: 0, lon: i * 0.00001,
    velNMps: 30, velEMps: 0, altitudeM, horizontalSpeedMps: 30,
    verticalSpeedMps, totalSpeedMps: Math.hypot(30, verticalSpeedMps), glideRatio: 4,
  })), 50);
}

test('flare gain uses negative-to-positive samples rather than top-100m start or peak', () => {
  const result = flare([[2520, 10], [2500, 5], [2480, -2], [2495, -1], [2498, 0], [2496, 2], [2400, 10]]);
  assert.equal(result.altitudeGainM, 16);
  assert.equal(result.startAltitudeM, 2500);
  assert.equal(result.endAltitudeM, 2400);
});
test('separate climbs are not combined', () => {
  assert.equal(flare([[2520, 10], [2500, -2], [2510, 2], [2505, -3], [2540, 2], [2400, 10]]).altitudeGainM, 10);
});
test('no climb produces zero and a climb without a positive endpoint is unavailable', () => {
  assert.equal(flare([[2520, 10], [2500, 0], [2400, 10]]).altitudeGainM, 0);
  assert.equal(flare([[2520, 10], [2500, -2], [2400, 0]]).altitudeGainM, null);
});

test('exit detection rejects poor acquisition fixes before a reliable jump', async () => {
  const { getValidatedJumpTrack } = await import('./gpsAnalysis.ts');
  const makeSegment = (offset, poor) => Array.from({ length: 150 }, (_, i) => {
    const v = i < 25 ? 0 : 20;
    return { time: String(offset + i), timestampMs: (offset + i) * 200,
      lat: 0, lon: 0, altitudeM: 3300 - Math.max(0, i - 25) * 4,
      horizontalSpeedMps: 50, verticalSpeedMps: v, totalSpeedMps: Math.hypot(50, v),
      velNMps: 50, velEMps: 0, glideRatio: v ? 2.5 : null,
      hAccM: poor ? 40 : 1, vAccM: poor ? 52 : 2, speedAccuracyMps: 0.5, numSV: 8 };
  });
  const poor = makeSegment(0, true), good = makeSegment(150, false);
  const result = getValidatedJumpTrack([...poor, ...good], 0);
  assert.ok(result.aircraftExitPoint.timestampMs >= good[0].timestampMs);
  assert.equal(getValidatedJumpTrack(poor, 0).isValidJump, false);
});
