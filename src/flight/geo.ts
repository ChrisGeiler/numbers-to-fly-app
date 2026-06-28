export type LatLon = {
  lat: number;
  lon: number;
};

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeLongitude(lonDeg: number): number {
  return ((lonDeg + 540) % 360) - 180;
}

export function signedAngleDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

export function nmToMetres(distanceNm: number): number {
  return distanceNm * 1852;
}

export function bearingBetweenPointsDeg(
  startLatDeg: number,
  startLonDeg: number,
  endLatDeg: number,
  endLonDeg: number
) {
  const startLatRad = degToRad(startLatDeg);
  const endLatRad = degToRad(endLatDeg);
  const deltaLonRad = degToRad(endLonDeg - startLonDeg);

  const y = Math.sin(deltaLonRad) * Math.cos(endLatRad);
  const x =
    Math.cos(startLatRad) * Math.sin(endLatRad) -
    Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLonRad);

  return normalizeDeg(radToDeg(Math.atan2(y, x)));
}

export function destinationPoint(
  startLatDeg: number,
  startLonDeg: number,
  bearingDeg: number,
  distanceM: number
): LatLon {
  const earthRadiusM = 6371000;
  const angularDistance = distanceM / earthRadiusM;

  const bearingRad = degToRad(bearingDeg);
  const startLatRad = degToRad(startLatDeg);
  const startLonRad = degToRad(startLonDeg);

  const endLatRad = Math.asin(
    Math.sin(startLatRad) * Math.cos(angularDistance) +
      Math.cos(startLatRad) * Math.sin(angularDistance) * Math.cos(bearingRad)
  );

  const endLonRad =
    startLonRad +
    Math.atan2(
      Math.sin(bearingRad) *
        Math.sin(angularDistance) *
        Math.cos(startLatRad),
      Math.cos(angularDistance) - Math.sin(startLatRad) * Math.sin(endLatRad)
    );

  return {
    lat: radToDeg(endLatRad),
    lon: normalizeLongitude(radToDeg(endLonRad)),
  };
}

export function calculateDropPoint(
  referenceLat: number,
  referenceLon: number,
  runHeadingDeg: number,
  dropDistanceNm: number
): LatLon {
  const backBearing = normalizeDeg(runHeadingDeg + 180);

  return destinationPoint(
    referenceLat,
    referenceLon,
    backBearing,
    nmToMetres(dropDistanceNm)
  );
}

export function buildLanePolygon(
  startPoint: LatLon,
  endPoint: LatLon,
  runHeadingDeg: number,
  halfWidthM: number
): [number, number][] {
  const leftBearing = normalizeDeg(runHeadingDeg - 90);
  const rightBearing = normalizeDeg(runHeadingDeg + 90);

  const startLeft = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    leftBearing,
    halfWidthM
  );

  const endLeft = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    leftBearing,
    halfWidthM
  );

  const endRight = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    rightBearing,
    halfWidthM
  );

  const startRight = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    rightBearing,
    halfWidthM
  );

  return [
    [startLeft.lat, startLeft.lon],
    [endLeft.lat, endLeft.lon],
    [endRight.lat, endRight.lon],
    [startRight.lat, startRight.lon],
  ];
}

export function buildLaneStripPolygon(
  startPoint: LatLon,
  endPoint: LatLon,
  runHeadingDeg: number,
  innerOffsetM: number,
  outerOffsetM: number,
  side: "left" | "right"
): [number, number][] {
  const bearing =
    side === "left"
      ? normalizeDeg(runHeadingDeg - 90)
      : normalizeDeg(runHeadingDeg + 90);

  const startInner = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    bearing,
    innerOffsetM
  );

  const endInner = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    bearing,
    innerOffsetM
  );

  const endOuter = destinationPoint(
    endPoint.lat,
    endPoint.lon,
    bearing,
    outerOffsetM
  );

  const startOuter = destinationPoint(
    startPoint.lat,
    startPoint.lon,
    bearing,
    outerOffsetM
  );

  return [
    [startInner.lat, startInner.lon],
    [endInner.lat, endInner.lon],
    [endOuter.lat, endOuter.lon],
    [startOuter.lat, startOuter.lon],
  ];
}
