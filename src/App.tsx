import { useMemo, useState } from "react";
import "./App.css";

type WindLayer = {
  altitudeM: number;
  directionFromDeg: number;
  speedKt: number;
};

type ResultRow = {
  altitudeM: number;
  tailwindKt: number;
  targetSpeedKph: number;
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

function smallestAngleDeg(a: number, b: number): number {
  const diff = Math.abs(normalizeDeg(a - b));
  return diff > 180 ? 360 - diff : diff;
}

function tailwindComponentKt(
  runHeadingDeg: number,
  windFromDeg: number,
  windSpeedKt: number
): number {
  const windTowardDeg = normalizeDeg(windFromDeg + 180);
  const angle = smallestAngleDeg(runHeadingDeg, windTowardDeg);
  return windSpeedKt * Math.cos(degToRad(angle));
}

function delayedPerformanceDropKph(altitudeM: number): number {
  if (altitudeM >= 2000) return 0;

  const drop = ((2000 - altitudeM) / 500) * 20;
  return Math.min(Math.max(drop, 0), 20);
}

function calculateTargets(
  zeroWindSpeedKph: number,
  runHeadingDeg: number,
  winds: WindLayer[]
): ResultRow[] {
  return winds.map((wind) => {
    const tailwindKt = tailwindComponentKt(
      runHeadingDeg,
      wind.directionFromDeg,
      wind.speedKt
    );

    const targetSpeedKph =
      zeroWindSpeedKph + tailwindKt - delayedPerformanceDropKph(wind.altitudeM);

    return {
      altitudeM: wind.altitudeM,
      tailwindKt: Math.round(tailwindKt),
      targetSpeedKph: Math.round(targetSpeedKph),
    };
  });
}

export default function App() {
  const [zeroWindSpeedKph, setZeroWindSpeedKph] = useState(185);
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
    () => calculateTargets(zeroWindSpeedKph, runHeadingDeg, winds),
    [zeroWindSpeedKph, runHeadingDeg, winds]
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
          Zero-wind target speed, km/h
          <input
            type="number"
            value={zeroWindSpeedKph}
            onChange={(e) => setZeroWindSpeedKph(Number(e.target.value))}
          />
        </label>

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
          <button type="button" onClick={() => applyWindToAll("directionFromDeg", 270)}>
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
              <th>Tailwind</th>
              <th>Target</th>
            </tr>
          </thead>

          <tbody>
            {results.map((row) => (
              <tr key={row.altitudeM}>
                <td>{row.altitudeM} m</td>
                <td>{row.tailwindKt} kt</td>
                <td>{row.targetSpeedKph} km/h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}