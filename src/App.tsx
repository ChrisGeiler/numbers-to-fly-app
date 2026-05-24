import { useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

type TaskMode = "time" | "distance" | "speed";
type WindSource = "manual" | "mark-schulze" | "windy";

type WindLayer = {
  altitudeM: number;
  directionFromDeg: string;
  speedKt: string;
};

type WindComponents = {
  tailwindKt: number;
  crosswindKt: number;
};

type ResultRow = {
  altitudeM: number;
  tailwindKt: number;
  crosswindKt: number;
  effectiveWindAheadKt?: number;
  targetSpeedKph?: number;
  targetGR?: number;
};

type MarkSchulzeResponse = {
  altSI?: number[];
  directionSI?: Record<string, number>;
  speedSI?: Record<string, number>;
  model?: string;
};

type LatLon = {
  lat: number;
  lon: number;
};

const altitudes = [
  2500, 2400, 2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500,
];

const defaultWinds: WindLayer[] = altitudes.map((altitudeM) => ({
  altitudeM,
  directionFromDeg: "",
  speedKt: "",
}));

const tailHeadDeadbandKt = 2;
const markSchulzeProxyUrl =
  "https://numbers-to-fly-winds.flywithcruza.workers.dev";

const referencePointIcon = L.divIcon({
  className: "reference-point-marker",
  html: "<div></div>",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const dropPointIcon = L.divIcon({
  className: "drop-point-marker",
  html: "<div></div>",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function numberFromInput(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberFromInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeLongitude(lonDeg: number): number {
  return ((lonDeg + 540) % 360) - 180;
}

function signedAngleDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function kmhToKt(speedKmh: number): number {
  return speedKmh / 1.852;
}

function nmToMetres(distanceNm: number): number {
  return distanceNm * 1852;
}

function destinationPoint(
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

function calculateDropPoint(
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

function applyTailHeadDeadband(tailwindKt: number): number {
  if (Math.abs(tailwindKt) <= tailHeadDeadbandKt) return 0;
  return tailwindKt;
}

function windComponents(
  runHeadingDeg: number,
  windFromDeg: number,
  windSpeedKt: number
): WindComponents {
  const windTowardDeg = normalizeDeg(windFromDeg + 180);
  const angle = signedAngleDeg(runHeadingDeg, windTowardDeg);

  const rawTailwindKt = windSpeedKt * Math.cos(degToRad(angle));
  const crosswindKt = windSpeedKt * Math.sin(degToRad(angle));

  return {
    tailwindKt: applyTailHeadDeadband(rawTailwindKt),
    crosswindKt,
  };
}

function delayedPerformanceDropKph(altitudeM: number): number {
  if (altitudeM >= 2200) return 0;

  const drop = ((2200 - altitudeM) / 700) * 30;
  return Math.min(Math.max(drop, 0), 30);
}

function baseGRAtAltitude(
  altitudeM: number,
  startGR: number,
  endGR: number
): number {
  const progress = (2500 - altitudeM) / 1000;
  return startGR + (endGR - startGR) * progress;
}

function leastFavorableWindAhead(index: number, tailwindsKt: number[]): number {
  return Math.min(...tailwindsKt.slice(index));
}

function grWindCorrection(effectiveWindAheadKt: number): number {
  if (effectiveWindAheadKt >= 0) return effectiveWindAheadKt / 100;
  return effectiveWindAheadKt / 50;
}

function blendedTimeWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;
  return tailwindKt + Math.max(0, crosswindCorrectionKph - Math.abs(tailwindKt));
}

function distanceWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const tailwindCorrectionKph = Math.max(tailwindKt, 0);
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;

  return Math.max(tailwindCorrectionKph, crosswindCorrectionKph);
}

function interpolateNumber(
  altitudeM: number,
  altitudeLevels: number[],
  valuesByAltitude: Record<string, number>
): number {
  const sortedAltitudes = [...altitudeLevels].sort((a, b) => a - b);

  const exactValue = valuesByAltitude[String(altitudeM)];
  if (exactValue !== undefined) return exactValue;

  const lowerAltitudes = sortedAltitudes.filter((alt) => alt <= altitudeM);
  const upperAltitudes = sortedAltitudes.filter((alt) => alt >= altitudeM);

  const lowerAltitude = lowerAltitudes[lowerAltitudes.length - 1];
  const upperAltitude = upperAltitudes[0];

  if (lowerAltitude === undefined && upperAltitude === undefined) {
    throw new Error("No altitude data available.");
  }

  if (lowerAltitude === undefined) return valuesByAltitude[String(upperAltitude)];
  if (upperAltitude === undefined) return valuesByAltitude[String(lowerAltitude)];
  if (lowerAltitude === upperAltitude)
    return valuesByAltitude[String(lowerAltitude)];

  const lowerValue = valuesByAltitude[String(lowerAltitude)];
  const upperValue = valuesByAltitude[String(upperAltitude)];
  const progress = (altitudeM - lowerAltitude) / (upperAltitude - lowerAltitude);

  return lowerValue + (upperValue - lowerValue) * progress;
}

function interpolateDirection(
  altitudeM: number,
  altitudeLevels: number[],
  directionsByAltitude: Record<string, number>
): number {
  const sortedAltitudes = [...altitudeLevels].sort((a, b) => a - b);

  const exactValue = directionsByAltitude[String(altitudeM)];
  if (exactValue !== undefined) return normalizeDeg(exactValue);

  const lowerAltitudes = sortedAltitudes.filter((alt) => alt <= altitudeM);
  const upperAltitudes = sortedAltitudes.filter((alt) => alt >= altitudeM);

  const lowerAltitude = lowerAltitudes[lowerAltitudes.length - 1];
  const upperAltitude = upperAltitudes[0];

  if (lowerAltitude === undefined && upperAltitude === undefined) {
    throw new Error("No altitude data available.");
  }

  if (lowerAltitude === undefined) {
    return normalizeDeg(directionsByAltitude[String(upperAltitude)]);
  }

  if (upperAltitude === undefined) {
    return normalizeDeg(directionsByAltitude[String(lowerAltitude)]);
  }

  if (lowerAltitude === upperAltitude) {
    return normalizeDeg(directionsByAltitude[String(lowerAltitude)]);
  }

  const lowerDirection = directionsByAltitude[String(lowerAltitude)];
  const upperDirection = directionsByAltitude[String(upperAltitude)];
  const progress = (altitudeM - lowerAltitude) / (upperAltitude - lowerAltitude);
  const shortestDifference = signedAngleDeg(lowerDirection, upperDirection);

  return normalizeDeg(lowerDirection + shortestDifference * progress);
}

function mapMarkSchulzeToWindLayers(data: MarkSchulzeResponse): WindLayer[] {
  if (!data.altSI || !data.directionSI || !data.speedSI) {
    throw new Error(
      "Mark Schulze response did not include altSI, directionSI, and speedSI."
    );
  }

  return altitudes.map((altitudeM) => {
    const directionFromDeg = interpolateDirection(
      altitudeM,
      data.altSI ?? [],
      data.directionSI ?? {}
    );

    const speedKmh = interpolateNumber(
      altitudeM,
      data.altSI ?? [],
      data.speedSI ?? {}
    );

    return {
      altitudeM,
      directionFromDeg: String(Math.round(directionFromDeg)),
      speedKt: String(Math.round(kmhToKt(speedKmh))),
    };
  });
}

function buildWindyUrl(lat: number, lon: number): string {
  return `https://www.windy.com/?wind,${lat.toFixed(4)},${lon.toFixed(4)},10`;
}

function preventSpeedIncreasesThroughWindow(rows: ResultRow[]): ResultRow[] {
  let previousSpeed: number | null = null;

  return rows.map((row) => {
    if (row.targetSpeedKph === undefined) return row;

    if (previousSpeed === null) {
      previousSpeed = row.targetSpeedKph;
      return row;
    }

    const cappedSpeed = Math.min(row.targetSpeedKph, previousSpeed);
    previousSpeed = cappedSpeed;

    return {
      ...row,
      targetSpeedKph: cappedSpeed,
    };
  });
}

function calculateTargets(
  taskMode: TaskMode,
  zeroWindSpeedKph: number,
  startGR: number,
  endGR: number,
  runHeadingDeg: number,
  winds: WindLayer[]
): ResultRow[] {
  const components = winds.map((wind) =>
    windComponents(
      runHeadingDeg,
      numberFromInput(wind.directionFromDeg, 0),
      numberFromInput(wind.speedKt, 0)
    )
  );

  const tailwindsKt = components.map((component) => component.tailwindKt);

  const rawRows = winds.map((wind, index) => {
    const tailwindKt = components[index].tailwindKt;
    const crosswindKt = components[index].crosswindKt;

    if (taskMode === "speed") {
      const effectiveWindAheadKt = leastFavorableWindAhead(index, tailwindsKt);
      const baseGR = baseGRAtAltitude(wind.altitudeM, startGR, endGR);
      const targetGR = baseGR + grWindCorrection(effectiveWindAheadKt);

      return {
        altitudeM: wind.altitudeM,
        tailwindKt: Math.round(tailwindKt),
        crosswindKt: Math.round(crosswindKt),
        effectiveWindAheadKt: Math.round(effectiveWindAheadKt),
        targetGR: Number(targetGR.toFixed(2)),
      };
    }

    if (taskMode === "time") {
      const targetSpeedKph =
        zeroWindSpeedKph +
        blendedTimeWindCorrectionKph(tailwindKt, crosswindKt) -
        delayedPerformanceDropKph(wind.altitudeM);

      return {
        altitudeM: wind.altitudeM,
        tailwindKt: Math.round(tailwindKt),
        crosswindKt: Math.round(crosswindKt),
        targetSpeedKph: Math.round(targetSpeedKph),
      };
    }

    const targetSpeedKph =
      zeroWindSpeedKph +
      distanceWindCorrectionKph(tailwindKt, crosswindKt) -
      delayedPerformanceDropKph(wind.altitudeM);

    return {
      altitudeM: wind.altitudeM,
      tailwindKt: Math.round(tailwindKt),
      crosswindKt: Math.round(crosswindKt),
      targetSpeedKph: Math.round(targetSpeedKph),
    };
  });

  if (taskMode === "speed") return rawRows;

  return preventSpeedIncreasesThroughWindow(rawRows);
}

function HeadingSlider({
  runHeadingDeg,
  onChange,
}: {
  runHeadingDeg: string;
  onChange: (value: string) => void;
}) {
  const heading = Math.round(numberFromInput(runHeadingDeg, 0));

  return (
    <div className="heading-slider-panel">
      <div className="heading-slider-readout">
        Flight heading:{" "}
        <strong>{runHeadingDeg.trim() === "" ? "---" : `${heading}°`}</strong>
      </div>

      <input
        className="heading-slider"
        type="range"
        min="0"
        max="359"
        step="1"
        value={numberFromInput(runHeadingDeg, 0)}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="heading-slider-scale">
        <span>000°</span>
        <span>090°</span>
        <span>180°</span>
        <span>270°</span>
        <span>359°</span>
      </div>
    </div>
  );
}

function MapClickPicker({
  referenceLat,
  referenceLon,
  dropPoint,
  onPick,
}: {
  referenceLat: string;
  referenceLon: string;
  dropPoint: LatLon | null;
  onPick: (lat: number, lon: number) => void;
}) {
  const lat = optionalNumberFromInput(referenceLat);
  const lon = optionalNumberFromInput(referenceLon);

  const center: [number, number] =
    lat !== null && lon !== null ? [lat, lon] : [-28.6474, 153.602];

  function ClickHandler() {
    useMapEvents({
      click(event) {
        onPick(event.latlng.lat, event.latlng.lng);
      },
    });

    return null;
  }

  const linePositions =
    lat !== null && lon !== null && dropPoint !== null
      ? [
          [dropPoint.lat, dropPoint.lon] as [number, number],
          [lat, lon] as [number, number],
        ]
      : [];

  return (
    <div className="map-picker">
      <MapContainer center={center} zoom={12} scrollWheelZoom={true}>
        <TileLayer
          attribution="Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />

        <ClickHandler />

        {dropPoint !== null && (
          <Marker
            position={[dropPoint.lat, dropPoint.lon]}
            icon={dropPointIcon}
          />
        )}

        {lat !== null && lon !== null && (
          <Marker position={[lat, lon]} icon={referencePointIcon} />
        )}

        {linePositions.length === 2 && (
          <Polyline
            positions={linePositions}
            pathOptions={{
              color: "#22d3ee",
              weight: 4,
              opacity: 0.9,
            }}
          />
        )}
      </MapContainer>
    </div>
  );
}

function TargetGraph({
  taskMode,
  results,
}: {
  taskMode: TaskMode;
  results: ResultRow[];
}) {
  const values = results.map((row) =>
    taskMode === "speed" ? row.targetGR ?? 0 : row.targetSpeedKph ?? 0
  );

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  const chartMin =
    taskMode === "speed" ? Math.floor(minValue * 2) / 2 : minValue - 5;

  const chartMax =
    taskMode === "speed" ? Math.ceil(maxValue * 2) / 2 : maxValue + 5;

  const range = chartMax - chartMin || 1;

  const width = 620;
  const height = 360;
  const leftPad = 58;
  const rightPad = 24;
  const topPad = 28;
  const bottomPad = 48;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;

  function xFromAltitude(altitudeM: number): number {
    const progress = (2500 - altitudeM) / 1000;
    return leftPad + progress * plotWidth;
  }

  function yFromValue(value: number): number {
    return topPad + (1 - (value - chartMin) / range) * plotHeight;
  }

  function smoothPath(points: { x: number; y: number }[]): string {
    if (points.length < 2) return "";

    const commands = [`M ${points[0].x} ${points[0].y}`];

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const midX = (previous.x + current.x) / 2;

      commands.push(
        `C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`
      );
    }

    return commands.join(" ");
  }

  const points = results.map((row) => {
    const value =
      taskMode === "speed" ? row.targetGR ?? 0 : row.targetSpeedKph ?? 0;

    return {
      x: xFromAltitude(row.altitudeM),
      y: yFromValue(value),
      value,
      altitudeM: row.altitudeM,
    };
  });

  const valueLabel = taskMode === "speed" ? "Target GR" : "Target speed km/h";

  const yTicks =
    taskMode === "speed"
      ? Array.from(
          { length: Math.round((chartMax - chartMin) / 0.5) + 1 },
          (_, index) => Number((chartMin + index * 0.5).toFixed(1))
        )
      : [chartMin, (chartMin + chartMax) / 2, chartMax];

  return (
    <section className="card">
      <h2>Window Graph</h2>

      <div className="graph-wrap">
        <svg
          className="target-graph"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Target graph"
        >
          <line
            x1={leftPad}
            y1={topPad}
            x2={leftPad}
            y2={topPad + plotHeight}
            className="axis"
          />

          <line
            x1={leftPad}
            y1={topPad + plotHeight}
            x2={leftPad + plotWidth}
            y2={topPad + plotHeight}
            className="axis"
          />

          {[2500, 2000, 1500].map((altitude) => {
            const x = xFromAltitude(altitude);

            return (
              <g key={altitude}>
                <line
                  x1={x}
                  y1={topPad}
                  x2={x}
                  y2={topPad + plotHeight}
                  className="grid"
                />
                <text
                  x={x}
                  y={height - 18}
                  textAnchor="middle"
                  className="graph-label"
                >
                  {altitude} m
                </text>
              </g>
            );
          })}

          {yTicks.map((tick, index) => {
            const y = yFromValue(tick);

            return (
              <g key={index}>
                <line
                  x1={leftPad}
                  y1={y}
                  x2={leftPad + plotWidth}
                  y2={y}
                  className="grid"
                />
                <text
                  x={leftPad - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="graph-label"
                >
                  {taskMode === "speed" ? tick.toFixed(1) : Math.round(tick)}
                </text>
              </g>
            );
          })}

          <path d={smoothPath(points)} className="target-line" />

          {points.map((point) => (
            <g key={point.altitudeM}>
              <circle cx={point.x} cy={point.y} r={4} className="target-dot" />
              <text
                x={point.x}
                y={point.y - 8}
                textAnchor="middle"
                className="point-label"
              >
                {taskMode === "speed"
                  ? point.value.toFixed(2)
                  : Math.round(point.value)}
              </text>
            </g>
          ))}

          <text
            x={leftPad + plotWidth / 2}
            y={height - 4}
            textAnchor="middle"
            className="graph-title"
          >
            Altitude
          </text>

          <text
            x={18}
            y={topPad + plotHeight / 2}
            textAnchor="middle"
            className="graph-title"
            transform={`rotate(-90 18 ${topPad + plotHeight / 2})`}
          >
            {valueLabel}
          </text>
        </svg>
      </div>
    </section>
  );
}

export default function App() {
  const [taskMode, setTaskMode] = useState<TaskMode>("distance");
  const [windSource, setWindSource] = useState<WindSource>("mark-schulze");

  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState("");
  const [startGR, setStartGR] = useState("");
  const [endGR, setEndGR] = useState("");
  const [runHeadingDeg, setRunHeadingDeg] = useState("");
  const [dropDistanceNm, setDropDistanceNm] = useState("");

  const [globalWindFromDeg, setGlobalWindFromDeg] = useState("");
  const [globalWindSpeedKt, setGlobalWindSpeedKt] = useState("");

  const [referenceLat, setReferenceLat] = useState("");
  const [referenceLon, setReferenceLon] = useState("");

  const [fetchStatus, setFetchStatus] = useState("");
  const [referenceStatus, setReferenceStatus] = useState("");
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [showRawWinds, setShowRawWinds] = useState(false);
  const [winds, setWinds] = useState<WindLayer[]>(defaultWinds);

  const calculatedDropPoint = useMemo(() => {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);
    const heading = optionalNumberFromInput(runHeadingDeg);
    const distanceNm = optionalNumberFromInput(dropDistanceNm);

    if (
      lat === null ||
      lon === null ||
      heading === null ||
      distanceNm === null ||
      distanceNm <= 0
    ) {
      return null;
    }

    return calculateDropPoint(lat, lon, heading, distanceNm);
  }, [referenceLat, referenceLon, runHeadingDeg, dropDistanceNm]);

  function updateWind(
    altitudeM: number,
    field: "directionFromDeg" | "speedKt",
    value: string
  ) {
    setWinds((currentWinds) =>
      currentWinds.map((wind) =>
        wind.altitudeM === altitudeM ? { ...wind, [field]: value } : wind
      )
    );
  }

  function applyGlobalWindToAll() {
    setWinds((currentWinds) =>
      currentWinds.map((wind) => ({
        ...wind,
        directionFromDeg: globalWindFromDeg,
        speedKt: globalWindSpeedKt,
      }))
    );
  }

  function updateHeadingFromSlider(value: string) {
    setRunHeadingDeg(value);
  }

  async function fetchMarkSchulzeWindsForLocation(lat: number, lon: number) {
    setFetchStatus("Fetching Mark Schulze winds...");

    const url = `${markSchulzeProxyUrl}/?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&hourOffset=0`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = (await response.json()) as MarkSchulzeResponse;
      const importedWinds = mapMarkSchulzeToWindLayers(data);

      setWinds(importedWinds);
      setFetchStatus(`Loaded ${data.model ?? "forecast"} winds.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while fetching winds.";

      setFetchStatus(`Could not fetch Mark Schulze winds. ${message}.`);
    }
  }

  async function setReferencePoint(lat: number, lon: number, sourceLabel: string) {
    const nextLat = lat.toFixed(6);
    const nextLon = lon.toFixed(6);

    setReferenceLat(nextLat);
    setReferenceLon(nextLon);
    setReferenceStatus(
      `Reference point set from ${sourceLabel}: ${nextLat}, ${nextLon}.`
    );

    if (windSource === "mark-schulze") {
      await fetchMarkSchulzeWindsForLocation(lat, lon);
    }
  }

  async function loadWindsFromEnteredReference() {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat === null || lon === null) {
      setFetchStatus("Enter reference latitude and longitude first.");
      return;
    }

    setReferenceStatus(`Reference point set manually: ${lat}, ${lon}.`);

    if (windSource === "mark-schulze") {
      await fetchMarkSchulzeWindsForLocation(lat, lon);
    }
  }

  async function pickReferenceFromMap(lat: number, lon: number) {
    await setReferencePoint(lat, lon, "map");
  }

  function handleWindSourceChange(source: WindSource) {
    setWindSource(source);
    setFetchStatus("");

    if (source === "manual") {
      setShowRawWinds(true);
      return;
    }

    setShowRawWinds(false);
  }

  function openWindyVisualCheck() {
    const lat = optionalNumberFromInput(referenceLat);
    const lon = optionalNumberFromInput(referenceLon);

    if (lat === null || lon === null) {
      setReferenceStatus("Set the reference point before opening Windy.");
      return;
    }

    window.open(buildWindyUrl(lat, lon), "_blank", "noopener,noreferrer");
  }

  const results = useMemo(
    () =>
      calculateTargets(
        taskMode,
        numberFromInput(zeroWindSpeedKph, 0),
        numberFromInput(startGR, 0),
        numberFromInput(endGR, 0),
        numberFromInput(runHeadingDeg, 0),
        winds
      ),
    [taskMode, zeroWindSpeedKph, startGR, endGR, runHeadingDeg, winds]
  );

  return (
    <main className="app">
      <header className="app-header">
        <img
          className="app-logo"
          src={`${import.meta.env.BASE_URL}numbers-to-fly-logo.png`}
          alt="Numbers to Fly logo"
        />

        <p className="subtitle">Know your numbers in the window.</p>
      </header>

      <section className="card">
        <h2>Setup</h2>

        <label>
          Task
          <select
            value={taskMode}
            onChange={(e) => setTaskMode(e.target.value as TaskMode)}
          >
            <option value="time">Time</option>
            <option value="distance">Distance</option>
            <option value="speed">Speed</option>
          </select>
        </label>

        {taskMode === "speed" ? (
          <>
            <label>
              Start GR at 2500 m
              <input
                type="number"
                step="0.05"
                value={startGR}
                placeholder="Example 1.10"
                onChange={(e) => setStartGR(e.target.value)}
              />
            </label>

            <label>
              End GR at 1500 m
              <input
                type="number"
                step="0.05"
                value={endGR}
                placeholder="Example 1.70"
                onChange={(e) => setEndGR(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            Zero-wind target speed, km/h
            <input
              type="number"
              value={zeroWindSpeedKph}
              placeholder="Example 185"
              onChange={(e) => setZeroWindSpeedKph(e.target.value)}
            />
          </label>
        )}

        <label>
          Drop distance from reference point, NM
          <input
            type="number"
            step="0.1"
            value={dropDistanceNm}
            placeholder="Example 3.0"
            onChange={(e) => setDropDistanceNm(e.target.value)}
          />
        </label>

        <h2>Reference Point</h2>

        <p className="subtitle">
          Choose the competition reference point on the map, or enter its
          coordinates manually.
        </p>

        <button
          type="button"
          className="primary-action-button"
          onClick={() => setShowMapPicker((current) => !current)}
        >
          {showMapPicker ? "Hide map" : "Choose reference point"}
        </button>

        {showMapPicker && (
          <>
            <p className="subtitle">
              Tap the map to set the reference point. Use the heading slider to
              rotate the flight line around the reference point.
            </p>

            <MapClickPicker
              referenceLat={referenceLat}
              referenceLon={referenceLon}
              dropPoint={calculatedDropPoint}
              onPick={pickReferenceFromMap}
            />
          </>
        )}

        <label>
          Run heading, degrees
          <input
            type="number"
            min="0"
            max="359"
            value={runHeadingDeg}
            placeholder="Example 90"
            onChange={(e) => setRunHeadingDeg(e.target.value)}
          />
        </label>

        <HeadingSlider
          runHeadingDeg={runHeadingDeg}
          onChange={updateHeadingFromSlider}
        />

        <div className="manual-wind-controls">
          <label>
            Latitude
            <input
              type="number"
              step="0.000001"
              value={referenceLat}
              placeholder="Example -28.514026"
              onChange={(e) => setReferenceLat(e.target.value)}
            />
          </label>

          <label>
            Longitude
            <input
              type="number"
              step="0.000001"
              value={referenceLon}
              placeholder="Example 153.551623"
              onChange={(e) => setReferenceLon(e.target.value)}
            />
          </label>
        </div>

        <button type="button" onClick={loadWindsFromEnteredReference}>
          Load winds from entered coordinates
        </button>

        {calculatedDropPoint && (
          <p className="subtitle">
            Drop/start point: {calculatedDropPoint.lat.toFixed(6)},{" "}
            {calculatedDropPoint.lon.toFixed(6)}
          </p>
        )}

        {referenceStatus && <p className="subtitle">{referenceStatus}</p>}
      </section>

      <section className="card">
        <h2>Wind</h2>

        <label>
          Source
          <select
            value={windSource}
            onChange={(e) => handleWindSourceChange(e.target.value as WindSource)}
          >
            <option value="mark-schulze">Mark Schulze</option>
            <option value="manual">Manual</option>
            <option value="windy">Windy visual check</option>
          </select>
        </label>

        {windSource === "windy" && (
          <button type="button" onClick={openWindyVisualCheck}>
            Open Windy visual check
          </button>
        )}

        {fetchStatus && <p className="subtitle">{fetchStatus}</p>}

        <button
          type="button"
          onClick={() => setShowRawWinds((current) => !current)}
        >
          {showRawWinds ? "Hide raw winds" : "Show raw winds"}
        </button>

        {showRawWinds && (
          <>
            <p className="subtitle">
              Raw winds used by the calculator. You can edit these manually if
              needed.
            </p>

            <div className="manual-wind-controls">
              <label>
                Set all wind from, degrees
                <input
                  type="number"
                  value={globalWindFromDeg}
                  placeholder="Example 270"
                  onChange={(e) => setGlobalWindFromDeg(e.target.value)}
                />
              </label>

              <label>
                Set all wind speed, kt
                <input
                  type="number"
                  value={globalWindSpeedKt}
                  placeholder="Example 20"
                  onChange={(e) => setGlobalWindSpeedKt(e.target.value)}
                />
              </label>

              <button type="button" onClick={applyGlobalWindToAll}>
                Apply to all altitudes
              </button>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Altitude</th>
                  <th>Wind from</th>
                  <th>Speed</th>
                </tr>
              </thead>

              <tbody>
                {winds.map((wind) => (
                  <tr key={wind.altitudeM}>
                    <td>{wind.altitudeM} m</td>
                    <td>
                      <input
                        className="table-input"
                        type="number"
                        value={wind.directionFromDeg}
                        placeholder="270"
                        onChange={(e) =>
                          updateWind(
                            wind.altitudeM,
                            "directionFromDeg",
                            e.target.value
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="table-input"
                        type="number"
                        value={wind.speedKt}
                        placeholder="20"
                        onChange={(e) =>
                          updateWind(wind.altitudeM, "speedKt", e.target.value)
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card">
        <h2>Numbers to Fly</h2>

        <table>
          <thead>
            <tr>
              <th>Alt</th>
              <th>T/H</th>
              <th>Xwind</th>
              {taskMode === "speed" && <th>Eff</th>}
              <th>{taskMode === "speed" ? "GR" : "Speed"}</th>
            </tr>
          </thead>

          <tbody>
            {results.map((row) => (
              <tr key={row.altitudeM}>
                <td>{row.altitudeM} m</td>
                <td>{row.tailwindKt} kt</td>
                <td>{row.crosswindKt} kt</td>
                {taskMode === "speed" && <td>{row.effectiveWindAheadKt} kt</td>}
                <td>
                  {taskMode === "speed"
                    ? row.targetGR?.toFixed(2)
                    : `${row.targetSpeedKph} km/h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <TargetGraph taskMode={taskMode} results={results} />
    </main>
  );
}