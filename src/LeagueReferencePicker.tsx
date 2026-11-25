import { useEffect, useState } from "react";
import { getDetectedJumpTrack, getValidatedJumpTrack, parseFlySightCsv } from "./gpsAnalysis";
import type { LeagueReferencePoint } from "./leagueReference";
import LeagueFlightMap from "./LeagueFlightMap";
import type { FlightMapPoint } from "./LeagueFlightMap";

export default function LeagueReferencePicker({file, ground, value, onChange}: {
  file: Blob | null; ground: number; value: LeagueReferencePoint | null;
  onChange: (point: LeagueReferencePoint | null) => void;
}) {
  const [draft, setDraft] = useState({name:value?.name ?? "",lat:value ? String(value.lat) : "",lon:value ? String(value.lon) : ""});
  useEffect(() => { if (value) setDraft({name:value.name,lat:String(value.lat),lon:String(value.lon)}); }, [value]);
  const change = (key: "name" | "lat" | "lon", text: string) => {
    const next = {...draft,[key]:text}; setDraft(next);
    onChange(next.name.trim() && next.lat.trim() && next.lon.trim() && Number.isFinite(Number(next.lat)) && Number.isFinite(Number(next.lon))
      ? {name:next.name.trim(),lat:Number(next.lat),lon:Number(next.lon)} : null);
  };
  const [points, setPoints] = useState<FlightMapPoint[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setPoints([]); setError("");
    if (file && (file.size === 0 || file.size > 8 * 1024 * 1024)) {
      setError("Choose a FlySight CSV smaller than 8 MB to preview the flight.");
      return;
    }
    if (file) void file.text().then(csv => {
      const all = parseFlySightCsv(csv);
      const validated = getValidatedJumpTrack(all, ground);
      const track = (validated.isValidJump ? validated.jumpPoints : getDetectedJumpTrack(all).jumpPoints)
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.altitudeM - ground >= 1450);
      const step = Math.max(1, Math.ceil(track.length / 1500));
      if (active) setPoints(track.filter((_, i) => i % step === 0 || i === track.length - 1)
        .map(p => ({lat: p.lat, lon: p.lon, altitudeM: p.altitudeM - ground})));
    }).catch(() => {if (active) setError("Track preview could not load. You can still enter reference coordinates below.");});
    return () => { active = false; };
  }, [file, ground]);
  return <section className="league-reference-picker">
    <h4>Flight reference point</h4>
    <p>Click the point you were flying towards, or enter its coordinates. Purple marks your reference; orange marks the scoring window.</p>
    {error && <p role="status">{error}</p>}
    <LeagueFlightMap points={points} reference={value} onPick={point => onChange({...point, name:draft.name.trim() || point.name})} />
    <div className="league-fields">
      <label>Reference name<input required maxLength={100} value={draft.name} placeholder="e.g. runway intersection"
        onChange={e => change("name", e.target.value)} /></label>
      <label>Reference latitude<input required type="number" step="any" min={-90} max={90} value={draft.lat} onChange={e => change("lat", e.target.value)} /></label>
      <label>Reference longitude<input required type="number" step="any" min={-180} max={180} value={draft.lon} onChange={e => change("lon", e.target.value)} /></label>
    </div>
    <p className="league-caption">For an approved result, the flight location and reference point will be visible on the public scoreboard map. Original CSV files and absolute timestamps remain private.</p>
  </section>;
}
