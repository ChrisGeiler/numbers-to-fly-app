import type {LatLon} from "./flight/geo";
import type {SavedReferencePoint, SavedReferencePointGroup} from "./referencePoints";
import {distanceBetweenLatLonM} from "./competitionLaneMath";
import "./CompetitionLane.css";

export default function CompetitionReferenceControls({pointA, groups, selectedGroupId,
  referenceLat, referenceLon, onLatitudeChange, onLongitudeChange, showMap,
  onShowMapChange, onClear, onSavedPick}: {
  pointA: LatLon | null; groups: SavedReferencePointGroup[]; selectedGroupId: string | null;
  referenceLat: string; referenceLon: string;
  onLatitudeChange: (value:string)=>void; onLongitudeChange: (value:string)=>void;
  showMap:boolean; onShowMapChange:(value:boolean)=>void; onClear:()=>void;
  onSavedPick:(group:SavedReferencePointGroup,point:SavedReferencePoint)=>void;
}) {
  const matches = pointA ? groups.flatMap(group => {
    if (!group.points.length) return [];
    const nearestDistanceM=Math.min(...group.points.map(point=>distanceBetweenLatLonM(pointA,point)));
    return nearestDistanceM <= 5*1852 ? [{group,nearestDistanceM}] : [];
  }).sort((a,b)=>a.nearestDistanceM-b.nearestDistanceM) : [];
  return <div className="competition-reference-controls">
    {!!matches.length && <div className="analyzer-reference-suggestions">
      <h3>Saved competition location detected</h3>
      <p>Point A is near saved reference points. Choose the assigned point to check the flown track against its 600 m lane.</p>
      {matches.map(({group,nearestDistanceM})=><div className={`analyzer-reference-group${selectedGroupId===group.id?" is-selected":""}`} key={group.id}>
        <div className="analyzer-reference-group-title"><strong>{group.name}</strong><span>Nearest point {(nearestDistanceM/1852).toFixed(1)} NM from Point A</span></div>
        <div className="analyzer-reference-options">{group.points.map((point,index)=><button type="button" key={point.id}
          className={referenceLat.trim() && referenceLon.trim() && Math.abs(point.lat-Number(referenceLat))<0.000001 && Math.abs(point.lon-Number(referenceLon))<0.000001 ? "is-selected":""}
          onClick={()=>onSavedPick(group,point)}>
          <span>{index+1}. {point.name}</span><small>{(distanceBetweenLatLonM(pointA!,point)/1852).toFixed(1)} NM from Point A</small>
        </button>)}</div>
      </div>)}
    </div>}
    <div className="competition-reference-grid">
      <label>Reference Point latitude<input type="number" min={-90} max={90} step="0.000001" value={referenceLat} placeholder="Example -33.123456" onChange={e=>onLatitudeChange(e.target.value)}/></label>
      <label>Reference Point longitude<input type="number" min={-180} max={180} step="0.000001" value={referenceLon} placeholder="Example 151.123456" onChange={e=>onLongitudeChange(e.target.value)}/></label>
    </div>
    <div className="window-adjust-controls">
      <button type="button" onClick={()=>onShowMapChange(!showMap)}>{showMap ? "Hide map":"Choose Reference Point on map"}</button>
      <button type="button" onClick={onClear}>Clear Reference Point</button>
    </div>
  </div>;
}
