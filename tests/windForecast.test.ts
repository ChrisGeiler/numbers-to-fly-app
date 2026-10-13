import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastUrl, mapForecast, forecastModelLabels } from '../src/windForecast.ts';
import type { ForecastModel, ForecastResponse } from '../src/windForecast.ts';
const target = Date.UTC(2026, 9, 13, 19);
function fixture(): ForecastResponse {
  return { elevation: 400, hourly: {
    time: [target / 1000],
    geopotential_height_850hPa: [1400], wind_speed_850hPa: [10], wind_direction_850hPa: [350],
    geopotential_height_700hPa: [3400], wind_speed_700hPa: [10], wind_direction_700hPa: [10],
  } };
}
test('explicit model and UTC hour are passed without seamless substitution', () => {
  for (const model of Object.keys(forecastModelLabels) as ForecastModel[]) {
    const url = new URL(forecastUrl(33.66, -117.33, model, target));
    assert.equal(url.searchParams.get('models'), model);
    assert.equal(url.searchParams.get('start_hour'), '2026-10-13T19:00');
    assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  }
});
test('uses actual heights, ground elevation, and vector interpolation across north', () => {
  const result = mapForecast(fixture(), target, [2000]);
  assert.equal(result.winds[0].directionFromDeg, '0');
  assert.equal(result.winds[0].speedKt, '10');
  assert.equal(result.minAltitudeAgl, 1000);
  assert.equal(result.maxAltitudeAgl, 3000);
  assert.equal(result.validTimeMs, target);
});
test('rejects unavailable times instead of choosing an unrelated hour', () => {
  assert.throws(() => mapForecast(fixture(), target + 3600000, [2000]), /hour is unavailable/);
});
test('rejects missing and out-of-range winds instead of assuming calm or clamping', () => {
  assert.throws(() => mapForecast(fixture(), target, [4000]), /No wind coverage/);
  const data = fixture();
  data.hourly!.wind_speed_700hPa = [null];
  assert.throws(() => mapForecast(data, target, [2000]), /No wind coverage/);
});
test('rejects absent ground elevation', () => {
  const data = fixture();
  delete data.elevation;
  assert.throws(() => mapForecast(data, target, [2000]), /ground elevation/);
});
