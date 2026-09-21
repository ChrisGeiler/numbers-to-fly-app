import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseEnergyManagement, energyAirspeedKph, energyGroundSpeedKph } from './energyManagement.ts';

test('only the personal account is eligible, including normalized email', () => {
  assert.equal(canUseEnergyManagement(' STARCRUZA@hotmail.com '), true);
  for (const email of [null, undefined, '', 'flywithcruza@gmail.com', 'starcruza@example.com']) assert.equal(canUseEnergyManagement(email), false);
});
test('profile preserves the middle reserve and increases bleed in the finish', () => {
  assert.equal(energyAirspeedKph(2500), 140);
  assert.equal(energyAirspeedKph(1750), 130);
  assert.equal(energyAirspeedKph(1500), 120);
  assert.equal(energyAirspeedKph(1500, 110), 110);
  assert.equal(energyAirspeedKph(3000), 140);
  assert.equal(energyAirspeedKph(1000), 120);
  let previous = Infinity;
  for (let h = 2500; h >= 1500; h--) { const v = energyAirspeedKph(h); assert.ok(v <= previous); previous = v; }
});
test('wind triangle converts knots and respects heading, crosswind, and infeasible tracks', () => {
  assert.equal(energyGroundSpeedKph(140, 0, 0, 0), 140);
  assert.ok(Math.abs(energyGroundSpeedKph(140, 0, 180, 10) - 158.52) < 1e-8);
  assert.ok(Math.abs(energyGroundSpeedKph(140, 0, 0, 10) - 121.48) < 1e-8);
  assert.ok(Math.abs(energyGroundSpeedKph(140, 0, 90, 10) - Math.sqrt(140**2 - 18.52**2)) < 1e-8);
  assert.equal(energyGroundSpeedKph(140, 0, 90, 100), null);
  assert.equal(energyGroundSpeedKph(140, 0, 0, 100), null);
  assert.equal(energyGroundSpeedKph(140, 0, 0, -1), null);
});
