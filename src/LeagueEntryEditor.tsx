import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { supabase } from "./supabase";
import { dropZoneReferences } from "./leagueDropZones";
import { leagueWindow } from "./leagueScoring";

export type EditableLeagueEntry = {
  id: string; round_id: string; file_path: string; public_name: string; region: string;
  discipline: string; location_name: string; ground_elevation_m: number;
  coaching_requested: boolean; revision?: number;
};
export default function LeagueEntryEditor({ client, entry, userId, onSaved, onCancel }: {
  client: typeof supabase; entry: EditableLeagueEntry; userId: string;
  onSaved: () => Promise<void>; onCancel: () => void;
}) {
  const [location, setLocation] = useState(entry.location_name);
  const [ground, setGround] = useState(String(entry.ground_elevation_m));
  const [original, setOriginal] = useState<Blob | null>(null);
  const [replacement, setReplacement] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading the saved track…");
  useEffect(() => {
    let active = true;
    void client.storage.from("league-tracks").download(entry.file_path).then(({data,error}) => {
      if (!active) return;
      setOriginal(error ? null : data);
      setStatus(error ? "Saved file could not load. Select a replacement CSV to continue." : "");
    }).catch(() => {if (active) setStatus("Saved file could not load. Select a replacement CSV to continue.");});
    return () => {active = false;};
  }, [client, entry.file_path]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setStatus("Saving changes…");
    const form = new FormData(event.currentTarget);
    let uploaded = "", saved = false;
    try {
      const file = replacement ?? original;
      if (!file || !file.size || file.size > 8 * 1024 * 1024) throw new Error("Choose a FlySight CSV smaller than 8 MB.");
      leagueWindow(await file.text(), Number(ground));
      if (replacement) {
        uploaded = `${userId}/${entry.round_id}/${crypto.randomUUID()}.csv`;
        const response = await client.storage.from("league-tracks").upload(uploaded, replacement, {contentType:"text/csv",upsert:false});
        if (response.error) throw response.error;
      }
      const response = await client.rpc("league_edit_entry", {
        entry_id: entry.id, expected_revision: entry.revision ?? 0,
        changes: { public_name: String(form.get("name")).trim(), region: form.get("region"),
          discipline: form.get("discipline"), location_name: location,
          ground_elevation_m: Number(ground), coaching_requested: form.get("coaching") === "on",
          file_path: uploaded || entry.file_path },
      });
      if (response.error) throw response.error;
      saved = true;
      // Only remove the superseded file after the entry points to the valid replacement.
      if (uploaded) await client.storage.from("league-tracks").remove([entry.file_path]);
      await onSaved();
    } catch(error) {
      if (uploaded && !saved) await client.storage.from("league-tracks").remove([uploaded]);
      setStatus((error as {message?:string}).message ?? "Changes could not be saved. Please retry.");
    } finally {setBusy(false);}
  }
  return <form className="league-pending-editor" onSubmit={save} aria-label={`Edit pending entry for ${entry.public_name}`}>
    <h4>Edit pending entry</h4>
    <fieldset disabled={busy}>
      <div className="league-fields">
        <label>Public competitor name<input name="name" required minLength={2} maxLength={60} defaultValue={entry.public_name} /></label>
        <label>Home state<select name="region" defaultValue={entry.region}>{["ACT","NSW","NT","QLD","SA","VIC","WA"].map(r => <option key={r}>{r}</option>)}</select></label>
        <label>Task<select name="discipline" defaultValue={entry.discipline}>{["speed","time","distance"].map(d => <option key={d}>{d}</option>)}</select></label>
        <label>Drop zone<select value={location} onChange={e => {
          setLocation(e.target.value);
          const dz = dropZoneReferences.find(d => d.name === e.target.value);
          setGround(dz?.metres == null ? "" : String(dz.metres));
        }}>{!dropZoneReferences.some(d => d.name === location) && <option>{location}</option>}{dropZoneReferences.map(d => <option key={d.name}>{d.name}</option>)}</select></label>
        <label>Elevation / metres<input type="number" required min={-100} max={3000} step="0.1" value={ground} onChange={e=>setGround(e.target.value)} /></label>
      </div>
      <label>Replacement FlySight CSV (optional)<input type="file" accept=".csv,text/csv,text/plain" onChange={e=>setReplacement(e.target.files?.[0]??null)} /><small>Leave blank to keep the saved track.</small></label>
      <label className="league-checkbox"><input name="coaching" type="checkbox" defaultChecked={entry.coaching_requested} /> Request remote coaching</label>
      <p className="league-caption">Saving clears the previous scores and replay. The revised entry stays pending for recalculation and organiser approval.</p>
      {status && <p className="league-notice" role="status">{status}</p>}
      <div className="league-review-actions"><button type="submit" className="league-button" disabled={!original && !replacement}>{busy ? "Saving…" : "Save changes"}</button><button type="button" className="league-secondary" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}
