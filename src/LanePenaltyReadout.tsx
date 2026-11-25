import type {LanePenaltyEstimate} from "./competitionLaneMath";
import "./CompetitionLane.css";
export default function LanePenaltyReadout({estimate}:{estimate:LanePenaltyEstimate|null}) {
  if (!estimate) return null;
  return <div className={`lane-penalty-estimate lane-penalty-${estimate.severity}`} role="status">
    <span>Estimated lane result</span><strong>{estimate.label}</strong>
    <p>Maximum lateral distance: {estimate.maxCenterlineDistanceM.toFixed(0)} m from the centreline. Maximum distance outside the 600 m lane: {estimate.maxOutsideLaneM.toFixed(0)} m.</p>
    <small>Calculated from the detected 10 m/s dive validation start through the competition-window exit. Setup flight before the run is excluded. This is an aid for review; official penalties remain subject to judge verification.</small>
  </div>;
}
