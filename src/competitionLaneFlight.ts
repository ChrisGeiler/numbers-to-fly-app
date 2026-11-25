import {getScoringWindowResult, getValidationStartIndex, getWindowTrackPoints} from "./gpsAnalysis.ts";
import type {GpsTrackPoint} from "./gpsAnalysis.ts";

// Shared with the analyser: final sustained dive + 9 s defines Point A.
// Evaluate through the scoring-window exit, excluding earlier setup flight.
export function competitionLaneGeometry(points:GpsTrackPoint[], windowOffsetM=0) {
  const result=getScoringWindowResult(points,windowOffsetM);
  const validationStartIndex=result ? getValidationStartIndex(points,result.startIndex) : null;
  const pointA=validationStartIndex===null ? null : points[validationStartIndex] ?? null;
  return {validationStartIndex,pointA,
    evaluationPoints:result && validationStartIndex!==null && result.endIndex>=validationStartIndex
      ? points.slice(validationStartIndex,result.endIndex+1) : [],
    windowPoints:result ? getWindowTrackPoints(points,windowOffsetM) : []};
}
