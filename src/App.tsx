import { useMemo, useState } from "react";
import "./App.css";

type TaskMode = "time" | "distance" | "speed";

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

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function signedAngleDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function windComponents(
  runHeadingDeg: number,
  windFromDeg: number,
  windSpeedKt: number
): WindComponents {
  const windTowardDeg = normalizeDeg(windFromDeg + 180);
  const angle = signedAngleDeg(runHeadingDeg, windTowardDeg);

  return {
    tailwindKt: windSpeedKt * Math.cos(degToRad(angle)),
    crosswindKt: windSpeedKt * Math.sin(degToRad(angle)),
  };
}

function delayedPerformanceDropKph(altitudeM: number): number {
  if (altitudeM >= 2000) return 0;

  const drop = ((2000 - altitudeM) / 500) * 20;
  return Math.min(Math.max(drop, 0), 20);
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
    // Tailwind: +0.1 GR per 10 kt
    return effectiveWindAheadKt / 100;
  }

  // Headwind: -0.2 GR per 10 kt
  return effectiveWindAheadKt / 50;
}

function blendedTimeWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;

  // Prevents quartering winds from double-counting tailwind + crosswind.
  // Crosswind only adds extra when it is larger than the along-track effect.
  return tailwindKt + Math.max(0, crosswindCorrectionKph - Math.abs(tailwindKt));
}

function distanceWindCorrectionKph(
  tailwindKt: number,
  crosswindKt: number
): number {
  const tailwindCorrectionKph = Math.max(tailwindKt, 0);
  const crosswindCorrectionKph = Math.abs(crosswindKt) * 0.5;

  // Prevents quartering tailwinds from adding both full tailwind and full crosswind correction.
  // Direct tailwind: uses tailwind.
  // Pure crosswind: uses crosswind correction.
  // Quartering tailwind: uses whichever correction is larger.
  // Headwind: does not reduce Distance target below zero-wind target.
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
        targetGR: Number(targetGR.toFixed(1)),
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

export default function App() {
  const [taskMode, setTaskMode] = useState<TaskMode>("distance");
  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState(185);
  const [startGR, setStartGR] = useState(1.1);
  const [endGR, setEndGR] = useState(1.7);
  const [runHeadingDeg, setRunHeadingDeg] = useState(90);
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

  function applyWindToAll(field: "directionFromDeg" | "speedKt", value: number) {
    setWinds((currentWinds) =>
      currentWinds.map((wind) => ({
        ...wind,
        [field]: value,
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
                step="0.1"
                value={startGR}
                onChange={(e) => setStartGR(Number(e.target.value))}
              />
            </label>

            <label>
              End GR at 1500 m
              <input
                type="number"
                step="0.1"
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
        <h2>Wind Profile</h2>
        <p className="subtitle">
          Enter aviation wind direction as the direction the wind is coming from.
        </p>

        <div className="quick-row">
          <button
            type="button"
            onClick={() => applyWindToAll("directionFromDeg", 270)}
          >
            Set all wind from 270°
          </button>
          <button type="button" onClick={() => applyWindToAll("speedKt", 20)}>
            Set all wind 20 kt
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
              <th>Along</th>
              <th>Cross</th>
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
                    ? `${row.targetGR?.toFixed(1)} : 1`
                    : `${row.targetSpeedKph} km/h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}