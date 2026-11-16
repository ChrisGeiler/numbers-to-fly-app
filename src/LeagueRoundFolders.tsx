import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export default function LeagueRoundFolders({enabled,rounds,selectedRoundId,onSelect,children}:{
  enabled:boolean;
  rounds:{id:string;title:string;opens_at:string;closes_at:string;published:boolean}[];
  selectedRoundId:string;
  onSelect:(id:string)=>void;
  children:ReactNode;
}) {
  const [openRoundId,setOpenRoundId]=useState<string|null>(selectedRoundId);
  useEffect(()=>setOpenRoundId(selectedRoundId),[selectedRoundId]);
  if(!enabled)return <>{children}</>;
  if(!rounds.length)return <p>No round folders yet. Create a round in Round control to get started.</p>;
  return <div className="league-round-folders">
    {rounds.map(round=><details className="league-round-folder" key={round.id} open={openRoundId===round.id}>
      <summary onClick={event=>{
        event.preventDefault();
        const next=openRoundId===round.id?null:round.id;
        setOpenRoundId(next);
        if(next && selectedRoundId!==round.id)onSelect(round.id);
      }}>
        <span aria-hidden="true">📁 </span><strong>{round.title}</strong>
        <span className="league-caption">{new Date(round.opens_at).toLocaleDateString("en-AU")} – {new Date(round.closes_at).toLocaleDateString("en-AU")}{!round.published?" · Draft":""}</span>
      </summary>
      {round.id===selectedRoundId && <div className="league-round-folder-contents">{children}</div>}
    </details>)}
  </div>;
}
