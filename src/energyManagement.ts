/** Personal experimental Time profile: horizontal true airspeed, not 3D speed. */
export function canUseEnergyManagement(email?: string | null): boolean {
  return email?.trim().toLowerCase() === 'starcruza@hotmail.com';
}

export function energyAirspeedKph(altitudeM: number, finishKph = 120): number {
  const altitude = Math.max(1500, Math.min(2500, altitudeM));
  const finish = Number.isFinite(finishKph) ? Math.max(90, Math.min(130, finishKph)) : 120;
  return altitude >= 1750
    ? 140 - (2500 - altitude) / 750 * 10
    : 130 - (1750 - altitude) / 250 * (130 - finish);
}

/** Ground-track heading held by crabbing; null means no forward solution. */
export function energyGroundSpeedKph(airKph: number, headingDeg: number, windFromDeg: number, windKt: number): number | null {
  if (![airKph, headingDeg, windFromDeg, windKt].every(Number.isFinite) || airKph <= 0 || windKt < 0) return null;
  const angle = (windFromDeg + 180 - headingDeg) * Math.PI / 180;
  const tail = windKt * 1.852 * Math.cos(angle);
  const cross = windKt * 1.852 * Math.sin(angle);
  if (Math.abs(cross) >= airKph) return null;
  const ground = Math.sqrt(airKph ** 2 - cross ** 2) + tail;
  return ground > 0 ? ground : null;
}
