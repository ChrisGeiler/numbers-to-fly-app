import { useEffect, useState } from "react";
import type { supabase } from "./supabase";
import type { LeagueReferencePoint } from "./leagueReference";
import { validLeagueReference } from "./leagueReference";
import LeagueReferencePicker from "./LeagueReferencePicker";

export default function LeagueReviewReference({client, entry, onSaved, userId}: {
  client: typeof supabase; userId?:string;
  entry: {id:string; file_path:string; ground_elevation_m:number; revision?:number; reference_point?:LeagueReferencePoint|null};
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<Blob|null>(null);
  const [point, setPoint] = useState(entry.reference_point ?? null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void client.storage.from("league-tracks").download(entry.file_path).then(({data,error}) => {
      if (!active) return;
      setFile(data); if (error) setStatus("Track preview unavailable. Enter the reference coordinates manually.");
    }).catch(() => {if (active) setStatus("Track preview unavailable. Enter the reference coordinates manually.");});
    return () => {active=false;};
  }, [open, client, entry.file_path]);
  if (!open) return <div><p>Reference point: {entry.reference_point?.name ?? "Not selected"}</p>
    <button className="league-secondary" onClick={() => setOpen(true)}>{entry.reference_point ? "Edit reference point" : "Add reference point"}</button></div>;
  return <form onSubmit={async event => {
    event.preventDefault(); if (!validLeagueReference(point)) return;
    setBusy(true); setStatus("Saving reference point…");
    try {
      const response = await client.rpc("league_set_reference_point", {entry_id:entry.id,expected_revision:entry.revision ?? 0, reference_point:point});
      if (response.error) throw response.error;
      await onSaved(); setOpen(false);
    } catch(error) {setStatus((error as {message?:string}).message ?? "Reference point could not save.");}
    finally {setBusy(false);}
  }}>
    <fieldset disabled={busy}>
      <LeagueReferencePicker userId={userId} file={file} ground={entry.ground_elevation_m} value={point} onChange={setPoint} />
      <p>Saving preserves the score and approval. For approved entries, this publishes the flight location and reference point on the scoreboard.</p>
      {status && <p role="status">{status}</p>}
      <button disabled={!validLeagueReference(point) || busy} className="league-secondary">Save reference point</button>{" "}
      <button type="button" onClick={() => setOpen(false)}>Cancel</button>
    </fieldset>
  </form>;
}
