import { useEffect, useRef, useState } from "react";
import type { supabase } from "./supabase";
import type { GpsTrackPoint } from "./gpsAnalysis";
import type { LeagueCompRun } from "./leagueCompRun";
import { compRunWindow } from "./leagueCompRun";
import InteractiveTrackChart from "./InteractiveTrackChart";
import LeagueFlightMap from "./LeagueFlightMap";
import "./LeagueCompRunViewer.css";

export default function LeagueCompRunViewer({client, entry, onClose}: {
  client:typeof supabase; entry:{id:string;name:string;task:string;attempt:number;score:number;unit:string}; onClose:()=>void;
}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [run,setRun]=useState<LeagueCompRun|null>(null);
  const [error,setError]=useState("");
  const [mode,setMode]=useState<"raw"|"corrected">("raw");
  useEffect(()=>{dialog.current?.showModal();},[]);
  useEffect(()=>{
    let active=true;
    void (async()=>{
      try {
        const response=await client.functions.invoke("league-flight",{body:{entry_id:entry.id}});
        if(response.error) {
          const detail=await (response.error as {context?:Response}).context?.json().catch(()=>null);
          throw new Error(detail?.error ?? response.error.message);
        }
        if(!response.data?.points?.length) throw new Error("Comp run is unavailable for this jump.");
        if(active){setRun(response.data);setMode(response.data.correctedAvailable?"corrected":"raw");}
      }catch(cause){if(active)setError(cause instanceof Error?cause.message:"Comp run could not load.");}
    })();
    return()=>{active=false;};
  },[client,entry.id]);
  const points:GpsTrackPoint[]=run?.points.map(point=>({time:"",timestampMs:point.seconds*1000,
    lat:0,lon:0,altitudeM:point.altitudeM,velNMps:point.horizontalSpeedMps,velEMps:0,
    horizontalSpeedMps:point.horizontalSpeedMps,verticalSpeedMps:point.verticalSpeedMps,
    totalSpeedMps:Math.hypot(point.horizontalSpeedMps,point.verticalSpeedMps),
    glideRatio:point.verticalSpeedMps>0?point.horizontalSpeedMps/point.verticalSpeedMps:null}))??[];
  return <dialog ref={dialog} className="league-comp-run" aria-labelledby="comp-run-title" onClose={onClose}>
    <header><div><p>FULL COMP RUN</p><h2 id="comp-run-title">{entry.name} · {entry.task} · Jump {entry.attempt}</h2></div>
      <button type="button" onClick={()=>dialog.current?.close()}>Close graph</button></header>
    <p className="league-comp-run-score"><strong>Approved {entry.task === "time"?"time":`wind-corrected ${entry.task}`} score: {entry.score.toFixed(entry.task==="time"?2:1)} {entry.unit}</strong></p>
    {!run && !error && <p role="status">Loading comp run…</p>}
    {error && <p role="alert">{error}</p>}
    {run && <>
      <p>{run.adjustedExit?"Corrected competition exit":"Detected exit"}: {run.exitAltitudeM.toFixed(0)} m AGL → 1,450 m AGL.</p>
      {!run.correctedAvailable && <p>Saved winds do not cover the entire comp run. Showing raw flight data; the approved score is unchanged.</p>}
      {run.map ? <section aria-label="Flight location">
        <h3>Flight towards {run.map.reference.name}</h3>
        <LeagueFlightMap points={run.map.points} reference={run.map.reference} />
        <p>Recorded ground track: orange shows 2,500–1,500 m AGL. Purple marks the selected reference point. The map stays ground-relative in both graph modes.</p>
      </section> : <p>A flight map will appear once the organiser adds this jump’s reference point.</p>}
      <InteractiveTrackChart points={points} recordedTimes={run.points.map(point=>point.seconds)} windowOffsetM={0}
        winds={[]} correctedHorizontalSpeedsMps={run.correctedAvailable?run.points.map(point=>point.airspeedMps!):undefined}
        graphView="comp" onGraphViewChange={()=>{}} scoreMode={mode} onScoreModeChange={setMode}
        showViewControls={false} showScoreModeControl hideAirspeedWithoutWinds competitionWindowTimes={compRunWindow(run)} />
    </>}
  </dialog>;
}
