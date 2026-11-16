import { getDetectedJumpTrack, getValidatedJumpTrack, parseFlySightCsv } from "./gpsAnalysis.ts";
import type { GpsTrackPoint } from "./gpsAnalysis.ts";
import { leagueWindAtPoint } from "./leagueScoring.ts";
import type { LeagueWindSnapshot } from "./leagueScoring.ts";

export type LeagueCompRun = {
  version: 1;
  exitAltitudeM: number;
  adjustedExit: boolean;
  correctedAvailable: boolean;
  points: {seconds: number; altitudeM: number; horizontalSpeedMps: number; verticalSpeedMps: number; airspeedMps: number | null}[];
};

// Public projection: relative time/AGL/flight metrics only, never GPS or UTC time.
export function buildLeagueCompRun(csv: string, ground: number, winds: LeagueWindSnapshot): LeagueCompRun {
  if (!Number.isFinite(ground)) throw new Error("Invalid DZ elevation.");
  const all = parseFlySightCsv(csv);
  const validated = getValidatedJumpTrack(all, ground);
  const detected = getDetectedJumpTrack(all);
  const track = validated.isValidJump ? validated.jumpPoints : detected.jumpPoints;
  if (track.length < 2 || track[0].timestampMs === null) throw new Error("A valid exit could not be detected.");
  const end = track.findIndex((point,index) => index > 0 && point.altitudeM-ground <= 1450 && track[index-1].altitudeM-ground > 1450);
  if (end < 1) throw new Error("This original track does not reach 1,450 m AGL after exit.");
  const a=track[end-1], b=track[end];
  const fraction=(a.altitudeM-ground-1450)/(a.altitudeM-b.altitudeM);
  const lerp=(x:number,y:number)=>x+(y-x)*fraction;
  const boundary: GpsTrackPoint={...a,altitudeM:ground+1450,
    timestampMs:lerp(a.timestampMs!,b.timestampMs!),lat:lerp(a.lat,b.lat),lon:lerp(a.lon,b.lon),
    velNMps:lerp(a.velNMps,b.velNMps),velEMps:lerp(a.velEMps,b.velEMps),
    horizontalSpeedMps:lerp(a.horizontalSpeedMps,b.horizontalSpeedMps),verticalSpeedMps:lerp(a.verticalSpeedMps,b.verticalSpeedMps)};
  const clipped=[...track.slice(0,end),boundary];
  if (clipped.length>10000) throw new Error("Comp run contains too many GPS samples.");
  const origin=clipped[0].timestampMs!;
  const points=clipped.map((point,index)=>{
    if (point.timestampMs===null || !Number.isFinite(point.timestampMs) ||
      (index && (point.timestampMs<=clipped[index-1].timestampMs! || point.timestampMs-clipped[index-1].timestampMs!>2000)) ||
      ![point.altitudeM,point.horizontalSpeedMps,point.verticalSpeedMps].every(Number.isFinite))
      throw new Error("Comp run contains missing timestamps, invalid samples or GPS gaps.");
    let airspeedMps:number|null=null;
    try {const wind=leagueWindAtPoint(point,winds); airspeedMps=Math.hypot(point.velNMps-wind.north,point.velEMps-wind.east);} catch { /* No extrapolated or zero-wind correction. */ }
    return {seconds:(point.timestampMs-origin)/1000,altitudeM:point.altitudeM-ground,
      horizontalSpeedMps:point.horizontalSpeedMps,verticalSpeedMps:point.verticalSpeedMps,airspeedMps};
  });
  return {version:1,exitAltitudeM:points[0].altitudeM,
    adjustedExit:validated.isValidJump && validated.exitPoint!==validated.aircraftExitPoint,
    correctedAvailable:points.every(point=>point.airspeedMps!==null),points};
}
