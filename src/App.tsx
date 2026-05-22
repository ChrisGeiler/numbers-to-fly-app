import { useMemo, useState } from "react";
import "./App.css";

type TaskMode = "time" | "distance" | "speed";
type WindSource = "manual" | "mark-schulze" | "windy";

type WindLayer = {
  altitudeM: number;
  directionFromDeg: number;
  speedKt: number;
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

const altitudes = [
  2500, 2400, 2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500,
];

const defaultWinds: WindLayer[] = altitudes.map((altitudeM) => ({
  altitudeM,
  directionFromDeg: 270,
  speedKt: 20,
}));

const tailHeadDeadbandKt = 2;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function signedAngleDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function applyTailHeadDeadband(tailwindKt: number): number {
  if (Math.abs(tailwindKt) <= tailHeadDeadbandKt) {
    return 0;
  }

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
  if (effectiveWindAheadKt >= 0) {
    return effectiveWindAheadKt / 100;
  }

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

function calculateTargets(
  taskMode: TaskMode,
  zeroWindSpeedKph: number,
  startGR: number,
  endGR: number,
  runHeadingDeg: number,
  winds: WindLayer[]
): ResultRow[] {
  const components = winds.map((wind) =>
    windComponents(runHeadingDeg, wind.directionFromDeg, wind.speedKt)
  );

  const tailwindsKt = components.map((component) => component.tailwindKt);

  return winds.map((wind, index) => {
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
      <p className="subtitle">
        Altitude runs left to right from 2500 m to 1500 m.
      </p>

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
  const [windSource, setWindSource] = useState<WindSource>("manual");
  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState(185);
  const [startGR, setStartGR] = useState(1.1);
  const [endGR, setEndGR] = useState(1.7);
  const [runHeadingDeg, setRunHeadingDeg] = useState(90);
  const [globalWindFromDeg, setGlobalWindFromDeg] = useState(270);
  const [globalWindSpeedKt, setGlobalWindSpeedKt] = useState(20);
  const [winds, setWinds] = useState<WindLayer[]>(defaultWinds);

  function updateWind(
    altitudeM: number,
    field: "directionFromDeg" | "speedKt",
    value: number
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

  const results = useMemo(
    () =>
      calculateTargets(
        taskMode,
        zeroWindSpeedKph,
        startGR,
        endGR,
        runHeadingDeg,
        winds
      ),
    [taskMode, zeroWindSpeedKph, startGR, endGR, runHeadingDeg, winds]
  );

  return (
    <main className="app">
      <header>
        <h1>Numbers to Fly</h1>
        <p className="subtitle">
          Wingsuit competition target calculator for the 2500 m to 1500 m
          performance window.
        </p>
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
                onChange={(e) => setStartGR(Number(e.target.value))}
              />
            </label>

            <label>
              End GR at 1500 m
              <input
                type="number"
                step="0.05"
                value={endGR}
                onChange={(e) => setEndGR(Number(e.target.value))}
              />
            </label>
          </>
        ) : (
          <label>
            Zero-wind target speed, km/h
            <input
              type="number"
              value={zeroWindSpeedKph}
              onChange={(e) => setZeroWindSpeedKph(Number(e.target.value))}
            />
          </label>
        )}

        <label>
          Run heading, degrees
          <input
            type="number"
            value={runHeadingDeg}
            onChange={(e) => setRunHeadingDeg(Number(e.target.value))}
          />
        </label>
      </section>

      <section className="card">
        <h2>Wind Source</h2>

        <label>
          Source
          <select
            value={windSource}
            onChange={(e) => setWindSource(e.target.value as WindSource)}
          >
            <option value="manual">Manual</option>
            <option value="mark-schulze">Mark Schulze</option>
            <option value="windy">Windy</option>
          </select>
        </label>

        {windSource === "manual" && (
          <p className="subtitle">
            Manual mode uses the wind table below. Automated wind import can be
            added once the wind source data format is confirmed.
          </p>
        )}

        {windSource === "mark-schulze" && (
          <p className="subtitle">
            Mark Schulze import is planned. For now, enter the winds manually
            below.
          </p>
        )}

        {windSource === "windy" && (
          <p className="subtitle">
            Windy verification is planned. For now, enter the winds manually
            below.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Wind Profile</h2>
        <p className="subtitle">
          Enter aviation wind direction as the direction the wind is coming from.
          Tail/head values within ±{tailHeadDeadbandKt} kt are treated as pure
          crosswind.
        </p>

        <div className="manual-wind-controls">
          <label>
            Set all wind from, degrees
            <input
              type="number"
              value={globalWindFromDeg}
              onChange={(e) => setGlobalWindFromDeg(Number(e.target.value))}
            />
          </label>

          <label>
            Set all wind speed, kt
            <input
              type="number"
              value={globalWindSpeedKt}
              onChange={(e) => setGlobalWindSpeedKt(Number(e.target.value))}
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
                    onChange={(e) =>
                      updateWind(
                        wind.altitudeM,
                        "directionFromDeg",
                        Number(e.target.value)
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="table-input"
                    type="number"
                    value={wind.speedKt}
                    onChange={(e) =>
                      updateWind(wind.altitudeM, "speedKt", Number(e.target.value))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Numbers to Fly</h2>

        <table>
          <thead>
            <tr>
              <th>Altitude</th>
              <th>Tail/Head</th>
              <th>Crosswind</th>
              {taskMode === "speed" && <th>Effective</th>}
              <th>{taskMode === "speed" ? "Target GR" : "Target speed"}</th>
            </tr>
          </thead>

          <tbody>
            {results.map((row) => (
              <tr key={row.altitudeM}>
                <td>{row.altitudeM} m</td>
                <td>{row.tailwindKt} kt</td>
                <td>{row.crosswindKt} kt</td>
                {taskMode === "speed" && (
                  <td>{row.effectiveWindAheadKt} kt</td>
                )}
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