import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateLeagueUploadScores, measureLeagueUploadWindow } from "../src/leagueUploadScore.ts";
import { scoreLeagueWindow, LEAGUE_WIND_MODEL } from "../src/leagueScoring.ts";
import type { GpsTrackPoint } from "../src/gpsAnalysis.ts";

const base = Date.parse("2026-11-01T00:00:00Z");
test("a FlySight file with a sample exactly on the window boundary calculates successfully", () => {
  const rows = ["time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV"];
  for (let i = 0; i < 520; i++) rows.push([new Date(base+i*200).toISOString(),-33+i*10/6371000*180/Math.PI,151,3300-Math.max(0,i-25)*4,50,0,i<25?0:20,1,2,0.5,17].join(","));
  const metrics = calculateLeagueUploadScores(rows.join("\n"),100);
  assert.equal(metrics.timeSeconds,50);
  assert.ok(Math.abs(metrics.distanceMetres-2500)<0.001);
  assert.ok(Math.abs(metrics.speedKmh-180)<0.001);
});
function points(times = [0, 2, 4, 6]): GpsTrackPoint[] {
  return times.map((t, i) => ({
    time: new Date(base + t * 1000).toISOString(),
    timestampMs: base + t * 1000,
    lat: -33 + (((600 * i) / 3 / 6371000) * 180) / Math.PI,
    lon: 151,
    altitudeM: 2500 - (i * 1000) / 3,
    velNMps: 100,
    velEMps: 0,
    horizontalSpeedMps: 100,
    verticalSpeedMps: 40,
    totalSpeedMps: 108,
    glideRatio: 2.5,
  }));
}
test("upload measurements agree with official unadjusted scoring values", () => {
  const window = points();
  const preview = measureLeagueUploadWindow(window);
  const official = scoreLeagueWindow(window, {
    model: LEAGUE_WIND_MODEL,
    fetched_at: new Date(base).toISOString(),
    hours: [base, base + 3600000].map((time) => ({
      time,
      levels: [0, 5000].map((height) => ({ height, north: 0, east: 0 })),
    })),
  });
  assert.equal(preview.timeSeconds, official.time_s);
  assert.equal(preview.distanceMetres, official.raw_distance_m);
  assert.equal(preview.speedKmh, official.raw_speed_kmh);
});
test("upload score uses timestamps rather than assuming a fixed GPS sample rate", () => {
  const metrics = measureLeagueUploadWindow(points([0, 1, 3, 5]));
  assert.equal(metrics.timeSeconds, 5);
  assert.ok(Math.abs(metrics.distanceMetres - 600) < 0.001);
  assert.ok(Math.abs(metrics.speedKmh - 432) < 0.001);
});
