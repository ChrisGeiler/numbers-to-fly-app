import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEAGUE_WIND_MODEL,
  scoreLeagueWindow,
  validateLeagueWindow,
  fetchLeagueWinds,
} from "../src/leagueScoring.ts";
import type { LeagueWindSnapshot } from "../src/leagueScoring.ts";
import type { GpsTrackPoint } from "../src/gpsAnalysis.ts";

const base = Date.parse("2026-11-01T00:00:00Z");
function points(): GpsTrackPoint[] {
  return [0, 2, 4, 6].map((t, i) => ({
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
function winds(north = 0, east = 0): LeagueWindSnapshot {
  return {
    model: LEAGUE_WIND_MODEL,
    fetched_at: new Date(base).toISOString(),
    hours: [0, 3600000].map((offset) => ({
      time: base + offset,
      levels: [0, 5000].map((height) => ({ height, north, east })),
    })),
  };
}
test("zero wind preserves speed and distance and uses recorded elapsed time", () => {
  const result = scoreLeagueWindow(points(), winds());
  assert.equal(result.time_s, 6);
  assert.ok(Math.abs(result.corrected_distance_m - 600) < 0.001);
  assert.ok(Math.abs(result.corrected_speed_kmh - 360) < 0.001);
  assert.equal(result.corrected_distance_m, result.raw_distance_m);
});
test("tailwind is removed and headwind is added without changing time", () => {
  const tail = scoreLeagueWindow(points(), winds(10));
  const head = scoreLeagueWindow(points(), winds(-10));
  assert.ok(Math.abs(tail.corrected_distance_m - 540) < 0.001);
  assert.ok(Math.abs(head.corrected_distance_m - 660) < 0.001);
  assert.equal(head.time_s, tail.time_s);
});
test("crosswind is removed as a vector rather than scalar subtraction", () => {
  const result = scoreLeagueWindow(points(), winds(0, 10));
  assert.ok(
    Math.abs(result.corrected_distance_m - Math.hypot(600, 60)) < 0.001,
  );
});
test("wind interpolation works across both time and height", () => {
  const snapshot = winds();
  snapshot.hours = [0, 6000].map((offset, index) => ({
    time: base + offset,
    levels: [0, 5000].map((height) => ({ height, north: index * 20, east: 0 })),
  }));
  const result = scoreLeagueWindow(points(), snapshot);
  assert.ok(Math.abs(result.corrected_distance_m - 540) < 0.001);
});
test("incomplete winds and different models fail instead of silently falling back", () => {
  const snapshot = winds();
  snapshot.hours[0].levels = [{ height: 3000, north: 0, east: 0 }];
  assert.throws(() => scoreLeagueWindow(points(), snapshot), /cover/);
  assert.throws(
    () => scoreLeagueWindow(points(), { ...winds(), model: "best_match" }),
    /fixed/,
  );
  assert.throws(
    () => scoreLeagueWindow(points(), { ...winds(), hours: [] }),
    /jump time/,
  );
});
test("gaps, duplicate timestamps, poor GPS and non-Australian positions are rejected", () => {
  const gap = points();
  gap[1].timestampMs = base + 3000;
  assert.throws(() => validateLeagueWindow(gap), /gaps/);
  const duplicate = points();
  duplicate[1].timestampMs = base;
  assert.throws(() => validateLeagueWindow(duplicate), /increase/);
  const poor = points();
  poor[1].hAccM = 100;
  assert.throws(() => validateLeagueWindow(poor), /accuracy/);
  const foreign = points();
  foreign[1].lat = 35;
  assert.throws(() => validateLeagueWindow(foreign), /Australia/);
});
test("missing forecast values do not become zero wind", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        hourly: {
          time: [base / 1000, base / 1000 + 3600],
          wind_speed_700hPa: [null, null],
          wind_direction_700hPa: [0, 0],
          geopotential_height_700hPa: [3000, 3000],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const snapshot = await fetchLeagueWinds(points(), fetcher);
  assert.equal(snapshot.hours[0].levels.length, 0);
  assert.throws(() => scoreLeagueWindow(points(), snapshot), /cover/);
});
