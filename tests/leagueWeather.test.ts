import { test } from "node:test";
import assert from "node:assert/strict";
import { createLeagueWeatherService } from "../server/leagueWeather.ts";
import { scoreLeagueWindow } from "../src/leagueScoring.ts";
import type { GpsTrackPoint } from "../src/gpsAnalysis.ts";

const base = Date.parse("2026-11-01T00:00:00Z");
const points = [0, 2, 4, 6].map((t, i) => ({
  timestampMs: base + t * 1000, time: new Date(base + t * 1000).toISOString(),
  lat: -33 + i * 0.001, lon: 151, altitudeM: 2500 - i * 1000 / 3,
  velNMps: 50, velEMps: 0,
})) as GpsTrackPoint[];
const primary = () => new Response(JSON.stringify({ hourly: {
  time: [base / 1000, base / 1000 + 3600],
  wind_speed_1000hPa: [10, 10], wind_direction_1000hPa: [180, 180], geopotential_height_1000hPa: [0, 0],
  wind_speed_500hPa: [10, 10], wind_direction_500hPa: [180, 180], geopotential_height_500hPa: [5000, 5000],
} }));
function fallback(missing = false) {
  return new Response(JSON.stringify({ status: "OK", user: "must-not-leak", data:
    [1000, 500].flatMap(p => [
      [`wind_speed_${p}hPa:ms`, missing ? null : 10],
      [`wind_dir_${p}hPa:d`, 180],
      [`geopotential_height_${p}hPa:m`, p === 1000 ? 0 : 5000],
    ]).map(([parameter, value]) => ({ parameter, coordinates: [{lat: -33, lon: 151,
      dates: [base, base + 3600000].map(time => ({ date: new Date(time).toISOString(), value })),
    }] })),
  }));
}
test("weather cache shares in-flight preview/review requests and retains provider", async () => {
  let calls = 0;
  const service = createLeagueWeatherService({}, (async () => { calls++; return primary(); }) as typeof fetch);
  const [a, b] = await Promise.all([service(points), service(points)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.provider, "open-meteo");
  await service(points);
  assert.equal(calls, 1);
});
test("timeout uses authenticated Meteomatics GFS fallback and saves its provenance", async () => {
  let calls = 0;
  const service = createLeagueWeatherService({ username: "test", password: "secret" }, (async (input, init) => {
    calls++;
    if (calls === 1) throw new DOMException("timed out", "TimeoutError");
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.meteomatics.com");
    assert.equal(url.searchParams.get("source"), "ncep-gfs");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${btoa("test:secret")}`);
    return fallback();
  }) as typeof fetch);
  const winds = await service(points);
  assert.equal(calls, 2);
  assert.equal(winds.provider, "meteomatics");
  assert.match(winds.fallback_reason!, /45-second/);
  assert.equal(scoreLeagueWindow(points, winds).time_s, 6);
  assert.ok(!JSON.stringify(winds).includes("secret"));
  assert.ok(!JSON.stringify(winds).includes("must-not-leak"));
});
test("missing account produces an actionable error and failed lookups can be retried", async () => {
  let calls = 0;
  const service = createLeagueWeatherService({}, (async () => { calls++; return new Response("", {status: 503}); }) as typeof fetch);
  await assert.rejects(service(points), /Meteomatics fallback is not configured/);
  await assert.rejects(service(points), /Meteomatics fallback is not configured/);
  assert.equal(calls, 2);
});
test("incomplete fallback winds never become an approvable zero-wind score", async () => {
  let calls = 0;
  const service = createLeagueWeatherService({username: "test", password: "secret"}, (async () => {
    calls++;
    return calls === 1 ? new Response("", {status: 503}) : fallback(true);
  }) as typeof fetch);
  await assert.rejects(service(points), /cover/);
});
test("invalid GPS is rejected before making any provider call", async () => {
  let calls = 0;
  const service = createLeagueWeatherService({}, (async () => {calls++; return primary();}) as typeof fetch);
  await assert.rejects(service(points.map(p => ({...p, lat: 30}))), /Australia/);
  assert.equal(calls, 0);
});
