import {useEffect,useMemo,useState} from "react";
import {getDetectedJumpTrack,getValidatedJumpTrack,parseFlySightCsv} from "./gpsAnalysis";
import type {GpsTrackPoint} from "./gpsAnalysis";
import type {LeagueReferencePoint} from "./leagueReference";
import {validLeagueReference} from "./leagueReference";
import {competitionLaneGeometry} from "./competitionLaneFlight";
import {estimateLanePenalty} from "./competitionLaneMath";
import {bearingBetweenPointsDeg} from "./flight/geo";
import {useReferencePoints} from "./useReferencePoints";
import CompetitionReferenceControls from "./CompetitionReferenceControls";
import LaneViewMap from "./LaneViewMap";
import LanePenaltyReadout from "./LanePenaltyReadout";
import type {SavedReferencePoint,SavedReferencePointGroup} from "./referencePoints";

export default function LeagueReferencePicker({file,ground,value,onChange,userId}:{
  file:Blob|null;ground:number;value:LeagueReferencePoint|null;onChange:(point:LeagueReferencePoint|null)=>void;userId?:string;
}) {
  const [lat,setLat]=useState(value ? value.lat.toFixed(6):"");
  const [lon,setLon]=useState(value ? value.lon.toFixed(6):"");
  const [showMap,setShowMap]=useState(false);
  const [groupId,setGroupId]=useState<string|null>(null);
  const [points,setPoints]=useState<GpsTrackPoint[]>([]);
  const [error,setError]=useState("");
  const {store}=useReferencePoints(userId);
  useEffect(()=>{if(value){setLat(value.lat.toFixed(6));setLon(value.lon.toFixed(6));}},[value]);
  useEffect(()=>{
    let active=true;setPoints([]);setError("");
    if(file && (file.size===0 || file.size>8*1024*1024)){setError("Choose a FlySight CSV smaller than 8 MB to preview the flight.");return;}
    if(file)void file.text().then(csv=>{
      const all=parseFlySightCsv(csv),validated=getValidatedJumpTrack(all,ground);
      const track=validated.isValidJump?validated.jumpPoints:getDetectedJumpTrack(all).jumpPoints;
      const end=track.findIndex(p=>p.altitudeM-ground<1450);
      if(active)setPoints((end<0?track:track.slice(0,end+1)).map(p=>({...p,altitudeM:p.altitudeM-ground})));
    }).catch(()=>{if(active)setError("Track preview could not load. Enter the reference coordinates below.");});
    return()=>{active=false;};
  },[file,ground]);
  const geometry=useMemo(()=>competitionLaneGeometry(points),[points]);
  const pointA=geometry.pointA;
  const commit=(nextLat:string,nextLon:string,name="Reference point")=>{
    setLat(nextLat);setLon(nextLon);
    const next={name,lat:Number(nextLat),lon:Number(nextLon)};
    onChange(nextLat.trim() && nextLon.trim() && validLeagueReference(next)?next:null);
  };
  const selectSaved=(group:SavedReferencePointGroup,point:SavedReferencePoint)=>{
    setGroupId(group.id);commit(point.lat.toFixed(6),point.lon.toFixed(6),point.name.slice(0,100));setShowMap(true);
  };
  const chosen=validLeagueReference(value)?value:null;
  const heading=pointA && chosen?String(bearingBetweenPointsDeg(pointA.lat,pointA.lon,chosen.lat,chosen.lon)):"";
  const saved=useMemo(()=>groupId && chosen ? store.groups.find(group=>group.id===groupId)?.points.filter(point=>Math.abs(point.lat-chosen.lat)<0.000001 && Math.abs(point.lon-chosen.lon)<0.000001) ?? []:[],[groupId,chosen,store.groups]);
  const penalty=pointA && chosen?estimateLanePenalty(geometry.evaluationPoints,pointA,chosen):null;
  return <section className="league-reference-picker competition-lane-ui">
    <h3>Competition Lane</h3>
    <p>Point A is detected 9 seconds after the scoring run reaches 10 m/s vertical speed. Enter or choose the competition reference point to draw the flown lane.</p>
    <div className="competition-lane-point-readout"><span>Point A</span><strong>{pointA?pointA.lat.toFixed(6)+", "+pointA.lon.toFixed(6):"Not detected"}</strong></div>
    {error && <p role="status">{error}</p>}
    <CompetitionReferenceControls pointA={pointA} groups={store.groups} selectedGroupId={groupId}
      referenceLat={lat} referenceLon={lon} onLatitudeChange={text=>{setGroupId(null);commit(text,lon);}}
      onLongitudeChange={text=>{setGroupId(null);commit(lat,text);}} showMap={showMap} onShowMapChange={setShowMap}
      onClear={()=>{setLat("");setLon("");setGroupId(null);onChange(null);}} onSavedPick={selectSaved}/>
    {showMap && pointA && <>
      <LaneViewMap referenceLat={lat} referenceLon={lon} dropPoint={pointA} runHeadingDeg={heading}
        dropDistanceNm="0" winds={[]} trackPoints={geometry.evaluationPoints} windowPoints={geometry.windowPoints}
        savedReferencePoints={saved} onSavedReferencePointPick={point=>{const group=store.groups.find(g=>g.id===groupId);if(group)selectSaved(group,point);}}
        onPick={(latitude,longitude)=>{setGroupId(null);commit(latitude.toFixed(6),longitude.toFixed(6));}}/>
      <p>Click the map to choose your reference point. North is always up.</p>
    </>}
    {showMap && !pointA && <p>Choose a valid FlySight track and drop zone elevation to detect Point A and open the map. You can also enter the reference coordinates above.</p>}
    {chosen && <div className="competition-lane-point-readout"><span>Reference Point</span><strong>{chosen.lat.toFixed(6)+", "+chosen.lon.toFixed(6)}</strong></div>}
    <LanePenaltyReadout estimate={penalty}/>
    {!chosen && <p>Add a reference point to populate the 600 m lane and overlay the flown track.</p>}
    <p>For an approved result, the flight location and reference point will be visible on the public scoreboard map. Original CSV files and absolute timestamps remain private. The lane estimate is an analysis aid and does not alter your league score.</p>
  </section>;
}
