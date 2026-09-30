import { test } from "node:test";
import assert from "node:assert/strict";
import { getTop100mFlareResult } from "../src/gpsAnalysis.ts";
import type { GpsTrackPoint } from "../src/gpsAnalysis.ts";

function track(altitudes: number[], ratios = altitudes.map(() => 4)): GpsTrackPoint[] {
  return altitudes.map((altitudeM, index) => {
    const verticalSpeedMps = index === 0 ? 20 : (altitudes[index - 1] - altitudeM) / 0.2;
    return {
      time: String(index), timestampMs: index * 200,
      lat: -33 + index * 0.0001, lon: 151,
      velNMps: 50, velEMps: 0, altitudeM,
      horizontalSpeedMps: 50, verticalSpeedMps,
      totalSpeedMps: Math.hypot(50, verticalSpeedMps),
      glideRatio: ratios[index],
    };
  });
}

test("early GR trigger with a climb inside the window measures from entry", () => {
  const result = getTop100mFlareResult(track([2540, 2520, 2500, 2480, 2490, 2520, 2450, 2400, 2300]), 60);
  assert.ok(result);
  assert.equal(result.startIndex, 2);
  assert.equal(result.startAltitudeM, 2500);
  assert.equal(result.endIndex, 7);
  assert.equal(result.timeSeconds, 1);
  assert.equal(result.altitudeGainM, 20);
  assert.ok(result.distanceM > 0);
});

test("early GR without an in-window climb keeps its original start", () => {
  const result = getTop100mFlareResult(track([2540, 2520, 2500, 2480, 2440, 2400]), 60);
  assert.equal(result?.startIndex, 0);
  assert.equal(result?.endIndex, 4);
});

test("a climb starting above the window does not activate the fallback", () => {
  const result = getTop100mFlareResult(track([2540, 2550, 2520, 2500, 2440, 2400]), 60);
  assert.equal(result?.startIndex, 0);
});

test("a GR trigger inside the window keeps its original start", () => {
  const result = getTop100mFlareResult(track([2540, 2500, 2480, 2490, 2380], [2, 2, 4, 4, 4]), 60);
  assert.equal(result?.startIndex, 2);
  assert.equal(result?.endIndex, 4);
});

test("a climb after leaving the window does not activate the fallback", () => {
  const result = getTop100mFlareResult(track([2540, 2500, 2440, 1500, 1490, 1510]), 60);
  assert.equal(result?.startIndex, 0);
});

test("existing missing-trigger fallback and minimum time remain unchanged", () => {
  const points = track([2540, 2500, 2450, 2400, 2300], [2, 2, 2, 2, 2]);
  assert.equal(getTop100mFlareResult(points, 60)?.startIndex, 1);
  assert.equal(getTop100mFlareResult(points, 30), null);
});

test("fallback needs entry and a complete 100 m measurement", () => {
  assert.equal(getTop100mFlareResult(track([2540, 2530, 2540]), 60), null);
  assert.equal(getTop100mFlareResult(track([2540, 2500, 2480, 2490, 2440]), 60), null);
});
