import { useEffect, useId, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { ReplayTrack } from "./LeagueScoreboard";
import { replayPointAt } from "./leagueReplay";
const colors = ["#1667a8", "#ba3c43", "#7553a0", "#25825a"];

export default function LeagueTrackReplay({ tracks }: { tracks: ReplayTrack[] }) {
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [rate, setRate] = useState(1);
  const [axis, setAxis] = useState<"distance" | "time">("distance");
  const [zoom, setZoom] = useState(1);
  const dragging = useRef(false);
  const clipId = useId().replace(/:/g, "");
  const duration = Math.max(...tracks.map(t => t.replay.points.at(-1)!.seconds));
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) {
        const delta = Math.min((now - previous) / 1000, 0.25) * rate;
        setSeconds(current => Math.min(duration, current + delta));
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, rate]);
  useEffect(() => {if (seconds >= duration) setPlaying(false);}, [seconds, duration]);
  const heads = tracks.map(track => replayPointAt(track.replay.points, seconds));
  const all = tracks.flatMap(track => track.replay.points);
  const xValue = (p: typeof all[number]) => axis === "time" ? p.seconds : p.forwardM;
  const min = axis === "time" ? 0 : Math.min(0, ...all.map(xValue));
  const max = axis === "time" ? duration : Math.max(1, ...all.map(xValue)) * 1.04;
  const width = (max - min) / zoom;
  const centre = heads.reduce((sum, p) => sum + xValue(p), 0) / heads.length;
  const xMin = Math.max(min, Math.min(max - width, centre - width / 2));
  const xMax = xMin + width;
  const x = (value: number) => 70 + (value - xMin) / (xMax - xMin) * 890;
  const y = (altitude: number) => 30 + (2600 - altitude) / 1100 * 300;
  const path = (points: typeof all) => points.map((p, i) => `${i ? "L" : "M"}${x(xValue(p)).toFixed(2)},${y(p.altitudeM).toFixed(2)}`).join(" ");
  function scrub(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width * 1000;
    const value = xMin + Math.max(0, Math.min(1, (px - 70) / 890)) * (xMax - xMin);
    setPlaying(false);
    if (axis === "time") setSeconds(Math.max(0, Math.min(duration, value)));
    else {
      const times = tracks.map(track => track.replay.points.reduce((best, p) =>
        Math.abs(p.forwardM - value) < Math.abs(best.forwardM - value) ? p : best).seconds);
      setSeconds(times.reduce((sum, t) => sum + t, 0) / times.length);
    }
  }
  return <section className="league-replay" aria-label="Wind-corrected track replay">
    <div className="league-section-top"><div><p className="league-eyebrow">FLY THE ROUND AGAIN</p><h3>Track replay</h3></div><b>{tracks.length} / 4 tracks</b></div>
    <p className="league-caption">Wind corrected using each entry’s saved weather. Flights start together at 2,500 m AGL and finish at 1,500 m. Flight directions are aligned for comparison.</p>
    <div className="league-replay-controls">
      <button className="league-button" onClick={() => { if (seconds >= duration) setSeconds(0); setPlaying(value => !value); }}>{playing ? "Pause" : "Play"} {playing ? "Ⅱ" : "▶"}</button>
      <button className="league-secondary" onClick={() => {setPlaying(false); setSeconds(0);}}>Restart</button>
      <label>Playback speed<select value={rate} onChange={e => setRate(Number(e.target.value))}>{[0.25, 0.5, 1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      <label>Horizontal axis<select value={axis} onChange={e => {setAxis(e.target.value as typeof axis); setZoom(1);}}><option value="distance">Corrected distance</option><option value="time">Elapsed time</option></select></label>
      <button className="league-secondary" aria-label="Zoom in replay" disabled={zoom >= 8} onClick={() => setZoom(v => Math.min(8, v * 2))}>Zoom +</button>
      <button className="league-secondary" disabled={zoom === 1} onClick={() => setZoom(1)}>Reset zoom</button>
    </div>
    <div className="league-replay-chart">
      <svg viewBox="0 0 1000 395" role="img" aria-label="Playback graph: altitude against corrected distance or elapsed time"
        onPointerDown={event => {dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); scrub(event);}}
        onPointerMove={event => {if (dragging.current) scrub(event);}}
        onPointerUp={() => {dragging.current = false;}} onPointerCancel={() => {dragging.current = false;}}>
        <defs><clipPath id={clipId}><rect x="70" y="25" width="890" height="310" /></clipPath></defs>
        {[1500, 1750, 2000, 2250, 2500, 2600].map(alt => <g key={alt}><line x1="70" x2="960" y1={y(alt)} y2={y(alt)} stroke="#cad2c2" strokeDasharray="5 4" /><text x="59" y={y(alt) + 5} textAnchor="end">{alt} m</text></g>)}
        {Array.from({length: 6}, (_, i) => {const value = xMin + (xMax - xMin) * i / 5; return <g key={i}><line x1={x(value)} x2={x(value)} y1="30" y2="330" stroke="#e0e5da" /><text x={x(value)} y="355" textAnchor="middle">{value.toFixed(0)} {axis === "time" ? "s" : "m"}</text></g>;})}
        <text x="515" y="385" textAnchor="middle">{axis === "time" ? "Time from scoring-window entry" : "Wind-corrected distance from scoring-window entry"}</text>
        <g clipPath={`url(#${clipId})`}>{tracks.map((track, i) => {
          const head = heads[i];
          const trace = [...track.replay.points.filter(p => p.seconds < seconds), head];
          return <g key={track.id}><path d={path(track.replay.points)} fill="none" stroke={colors[i]} strokeWidth="2" opacity="0.18" />
            <path d={path(trace)} fill="none" stroke={colors[i]} strokeWidth="3.5" />
            <circle cx={x(xValue(head))} cy={y(head.altitudeM)} r="7" fill={colors[i]} stroke="white" strokeWidth="2" /></g>;
        })}</g>
      </svg>
    </div>
    <label className="league-replay-scrubber">Replay position: {seconds.toFixed(1)} / {duration.toFixed(1)} seconds
      <input type="range" min={0} max={duration} step="any" value={seconds} onChange={e => {setPlaying(false); setSeconds(Number(e.target.value));}} />
    </label>
    <div className="league-replay-readouts">{tracks.map((track, i) => <article key={track.id} style={{borderTopColor: colors[i]}}>
      <strong style={{color: colors[i]}}>{track.public_name}</strong><small>{track.discipline} · Jump {track.attempt} · {track.replay.provider === "meteomatics" ? "Meteomatics" : "Open-Meteo"} / GFS</small>
      <p>{heads[i].altitudeM.toFixed(0)} m AGL · {heads[i].forwardM.toFixed(1)} m</p>
      <p>{heads[i].speedKmh.toFixed(1)} km/h · {seconds >= track.replay.points.at(-1)!.seconds ? "Finished" : `${heads[i].seconds.toFixed(1)} s`}</p>
    </article>)}</div>
    <p className="league-caption">Drag across the graph or use the slider to scrub. Replay shows only the scored window; it does not disclose original GPS locations.</p>
  </section>;
}
