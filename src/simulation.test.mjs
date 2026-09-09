import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseWindowAudioFirmware, detectSimulationFirmware, readSimulationConfig, simulationFirmwareTimeline, simulationTimeline, simulationValue, simulationWindow, simulationSuppressed, simulationSpeechDue, simulationSpeechNumber, simulationTone } from './simulation.ts';

test('config parser preserves repeated alarms and ignores commented settings', () => {
  const result = readSimulationConfig(`; Min: 999
Mode: 2 ; glide ratio
Min: 340
Max: 380
DZ_Elev: 120
Win_Top: 4300
Win_Bottom: 2500
Alarm_Elev: 3000
Alarm_Type: 4
Alarm_File: 5
Alarm_Elev: 2500
Alarm_Type: 1
Alarm_File: 0`);
  assert.equal(result.values.Min, 340);
  assert.equal(result.values.DZ_Elev, 120);
  assert.deepEqual(result.alarms, [
    { elevation: 3000, type: 4, file: '5' },
    { elevation: 2500, type: 1, file: '0' },
  ]);
});

test('timeline uses recorded intervals and removes invalid or backwards timestamps', () => {
  const result = simulationTimeline([1000, 1200, null, 1200, 1100, 1150, 1700].map(timestampMs => ({ timestampMs })));
  assert.deepEqual(result.map(p => p.seconds), [0, 0.2, 0.7]);
  assert.deepEqual(simulationTimeline([]), []);
});

test('task measurements use config units without inventing missing glide ratios', () => {
  const point = { horizontalSpeedMps: 75, verticalSpeedMps: 20, glideRatio: 3.75 };
  assert.equal(simulationValue(point, 0), 7500);
  assert.equal(simulationValue(point, 1), 2000);
  assert.equal(simulationValue(point, 2), 375);
  assert.equal(simulationValue({ ...point, verticalSpeedMps: 0, glideRatio: null }, 2), null);
});

test('simulation clips to AGL boundaries, interpolates crossings and resets time', () => {
  const points = [3600, 3400, 2600, 1700, 1500, 1800].map((altitudeM, i) => ({
    altitudeM, timestampMs: 1000 + i * 1000, lat: 0, lon: 0, velNMps: 50,
    velEMps: 0, horizontalSpeedMps: 50, verticalSpeedMps: 20,
    totalSpeedMps: 54, glideRatio: 2.5,
  }));
  const result = simulationWindow(points, 100);
  assert.equal(result[0].altitudeM, 3453);
  assert.equal(result[0].seconds, 0);
  assert.equal(result.at(-1).altitudeM, 1600);
  assert.equal(result.at(-1).timestampMs, 4500);
  assert.ok(result.every(p => p.altitudeM >= 1600 && p.altitudeM <= 3453));
  assert.deepEqual(simulationWindow(points, 4000), []);
});

test('GR is due below 2600 after the beep without a fresh two-second wait', () => {
  const config = { values: { Win_Top: 4300, Win_Bottom: 2600, Win_Above: 50, Win_Below: 0 }, alarms: [{ elevation: 2600, type: 1 }] };
  assert.equal(simulationSuppressed(2600, config), true);
  assert.equal(simulationSuppressed(2599, config), false);
  assert.equal(simulationSpeechDue(10, 2, 2, true, true, false), false);
  assert.equal(simulationSpeechDue(10.1, 2, 2, false, true, true), false);
  assert.equal(simulationSpeechDue(10.2, 2, 2, false, true, false), true);
  assert.equal(simulationSpeechDue(10.3, 12.2, 2, false, true, false), false);
  assert.equal(simulationSpeechDue(12.2, 12.2, 2, false, true, false), true);
  assert.equal(simulationSpeechDue(12.2, 2, 0, false, true, false), false);
  assert.equal(simulationSpeechDue(12.2, 2, 2, false, false, false), false);
});

test('alarm margins silence readings before the alarm and clear below it', () => {
  const config = { values: { Win_Top: 4300, Win_Bottom: 2600, Win_Above: 50, Win_Below: 0 }, alarms: [{ elevation: 1600, type: 1 }] };
  assert.equal(simulationSuppressed(1650, config), true);
  assert.equal(simulationSuppressed(1625, config), true);
  assert.equal(simulationSuppressed(1599, config), false);
});

test('FlySight 2 pitch and rate use tone bounds, and speech truncates decimals', () => {
  const values = { Min: 1000, Max: 2000, Min_Val_2: 300, Max_Val_2: 1500, Min_Rate: 100, Max_Rate: 500 };
  assert.deepEqual(simulationTone(1000, 1000, 0.4, values), { pitch: 220, rate: 1 });
  assert.deepEqual(simulationTone(2000, 2000, 0.4, values), { pitch: 1760, rate: 1 });
  assert.equal(simulationTone(1500, 1500, 0.4, values).pitch, 990);
  assert.equal(simulationTone(1500, 1560, 0.4, values).rate, 5);
  assert.equal(simulationSpeechNumber(3.79, 1), '3.7');
  assert.equal(simulationSpeechNumber(279.9, 0), '279');
});

test('FLYSIGHT.TXT selects the private firmware only for the installed feature build', () => {
  assert.deepEqual(
    detectSimulationFirmware('Firmware_Ver: v2024.12.30.10-1-g8ae5110\n'),
    { version: 'v2024.12.30.10-1-g8ae5110', profile: 'window-audio' },
  );
  assert.deepEqual(
    detectSimulationFirmware('Firmware_Ver: v2024.12.30.10\n'),
    { version: 'v2024.12.30.10', profile: 'standard' },
  );
});

test('private firmware simulator access is restricted to Chris account', () => {
  assert.equal(canUseWindowAudioFirmware('starcruza@hotmail.com'), true);
  assert.equal(canUseWindowAudioFirmware(' StarCruza@Hotmail.com '), true);
  assert.equal(canUseWindowAudioFirmware('another@example.com'), false);
  assert.equal(canUseWindowAudioFirmware(null), false);
});

test('private firmware stays silent before entry and releases suppression after a confirmed flare climb', () => {
  const config = readSimulationConfig(`Rate: 200
Win_Top: 4300
Win_Bottom: 2500
Win_Above: 50
Win_Below: 0`);
  const samples = [
    [2700, 5],
    [2720, -4],
    [2600, 22],
    [2570, 22],
    [2540, 22],
    [2520, 22],
    [2501, 22],
    [2490, 22],
    [2460, 22],
    [2450, 22],
    [2470, -4],
    [2501, -4],
  ].map(([altitudeM, verticalSpeedMps], index) => ({
    time: '', timestampMs: index * 200, seconds: index * 0.2,
    altitudeM, verticalSpeedMps, vAccM: 5,
    lat: 0, lon: 0, velNMps: 50, velEMps: 0,
    horizontalSpeedMps: 50, totalSpeedMps: 55, glideRatio: 2.5,
  }));

  const privateTimeline = simulationFirmwareTimeline(samples, 0, config, 'window-audio');
  const standardTimeline = simulationFirmwareTimeline(samples, 0, config, 'standard');

  assert.equal(privateTimeline[1].state, 'pre-flight');
  assert.equal(privateTimeline[1].suppressed, true);
  assert.equal(privateTimeline[6].state, 'flight-confirmed');
  assert.equal(privateTimeline[7].state, 'window-entered');
  assert.equal(privateTimeline[11].state, 'post-window-audio');
  assert.equal(privateTimeline[11].rawSuppression, true);
  assert.equal(privateTimeline[11].suppressed, false);
  assert.equal(standardTimeline[11].suppressed, true);
});
