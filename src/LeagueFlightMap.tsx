import {bearingBetweenPointsDeg} from "./flight/geo";
import type {LeagueCompRun} from "./leagueCompRun";
import LaneViewMap from "./LaneViewMap";
import LanePenaltyReadout from "./LanePenaltyReadout";
export default function LeagueFlightMap({map}:{map:NonNullable<LeagueCompRun["map"]>}) {
  const lane=map.lane,pointA=lane?.pointA;
  return <section className="competition-lane-ui" aria-label="Competition lane map">
    <h3>Competition Lane</h3><p>Point A is detected 9 seconds after the scoring run reaches 10 m/s vertical speed.</p>
    {pointA && lane ? <>
      <div className="competition-lane-point-readout"><span>Point A</span><strong>{pointA.lat.toFixed(6)+", "+pointA.lon.toFixed(6)}</strong></div>
      <LaneViewMap referenceLat={String(map.reference.lat)} referenceLon={String(map.reference.lon)}
        dropPoint={pointA} runHeadingDeg={String(bearingBetweenPointsDeg(pointA.lat,pointA.lon,map.reference.lat,map.reference.lon))}
        dropDistanceNm="0" trackPoints={lane.evaluationPoints} windowPoints={lane.windowPoints} winds={lane.winds}/>
      <p>North is always up. The cyan track and 600 m lane use the recorded ground flight, in both graph modes.</p>
      <div className="competition-lane-point-readout"><span>Reference Point · {map.reference.name}</span><strong>{map.reference.lat.toFixed(6)+", "+map.reference.lon.toFixed(6)}</strong></div>
      <LanePenaltyReadout estimate={lane.penalty}/>
      <p>This estimate is an analysis aid and does not alter the approved league score.</p>
    </> : <p>A valid Point A could not be detected for this flight. No lane penalty is estimated.</p>}
  </section>;
}
