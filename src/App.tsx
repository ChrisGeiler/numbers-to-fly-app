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
  const [windFromDeg, setWindFromDeg] = useState(270);
  const [windSpeedKt, setWindSpeedKt] = useState(20);

  const winds = useMemo(
    () =>
      altitudes.map((altitudeM) => ({
        altitudeM,
        directionFromDeg: windFromDeg,
        speedKt: windSpeedKt,
      })),
    [windFromDeg, windSpeedKt]
  );

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

        <label>
          Wind from, degrees
          <input
            type="number"
            value={windFromDeg}
            onChange={(e) => setWindFromDeg(Number(e.target.value))}
          />
        </label>

        <label>
          Wind speed, kt
          <input
            type="number"
            value={windSpeedKt}
            onChange={(e) => setWindSpeedKt(Number(e.target.value))}
          />
        </label>
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