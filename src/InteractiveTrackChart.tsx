import { Fragment, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { measureChartRange } from './chartMeasurement';
import { GPS_SAMPLE_PERIOD_SECONDS, metresPerSecondToKmh } from './gpsAnalysis';
import type { GpsTrackPoint } from './gpsAnalysis';
import { degToRad, normalizeDeg } from './flight/geo';
import { numberFromInput, interpolateDirection, interpolateNumber, getDisplayHorizontalSpeedMps, getDisplayTotalSpeedMps, getDisplayGlideRatio } from './flightChartMath';
import type { WindLayer } from './flightChartMath';
export default function InteractiveTrackChart({
  points,
  playbackPosition,
  recordedTimes,
  windowOffsetM,
  winds,
  graphView,
  onGraphViewChange,
  scoreMode,
  onScoreModeChange,
  showCompetitionContext = true,
  showScoreModeControl = showCompetitionContext,
  showViewControls = showCompetitionContext,
  exitSelectionMode = false,
  onExitPointSelect,
  onCancelExitSelection,
  correctedHorizontalSpeedsMps,
  hideAirspeedWithoutWinds = false,
  competitionWindowTimes,
}: {
  points: GpsTrackPoint[];
  playbackPosition?: number;
  recordedTimes?: number[];
  windowOffsetM: number;
  winds: WindLayer[];
  graphView: "comp" | "full";
  onGraphViewChange: (view: "comp" | "full") => void;
  scoreMode: "raw" | "corrected";
  onScoreModeChange: (mode: "raw" | "corrected") => void;
  showCompetitionContext?: boolean;
  showScoreModeControl?: boolean;
  showViewControls?: boolean;
  exitSelectionMode?: boolean;
  onExitPointSelect?: (point: GpsTrackPoint) => void;
  onCancelExitSelection?: () => void;
  correctedHorizontalSpeedsMps?: number[];
  hideAirspeedWithoutWinds?: boolean;
  competitionWindowTimes?: {start:number;end:number};
}) {
const windsAvailable = winds.length > 0 || correctedHorizontalSpeedsMps !== undefined;
const windAltitudes = winds.map((wind) => wind.altitudeM);

const windDirectionsByAltitude = Object.fromEntries(
  winds.map((wind) => [
    String(wind.altitudeM),
    numberFromInput(wind.directionFromDeg, 0),
  ])
);

const windSpeedsByAltitude = Object.fromEntries(
  winds.map((wind) => [
    String(wind.altitudeM),
    numberFromInput(wind.speedKt, 0),
  ])
);

const chartData = points.map((point, index) => {
  const windDirectionFromDeg =
    winds.length > 0
      ? interpolateDirection(
          point.altitudeM,
          windAltitudes,
          windDirectionsByAltitude
        )
      : 0;

  const windSpeedKt =
    winds.length > 0
      ? interpolateNumber(
          point.altitudeM,
          windAltitudes,
          windSpeedsByAltitude
        )
      : 0;

  const windTowardDeg = normalizeDeg(windDirectionFromDeg + 180);
  const windSpeedMps = windSpeedKt * 0.514444;
  const windTowardRad = degToRad(windTowardDeg);

  const windNorthMps = Math.cos(windTowardRad) * windSpeedMps;
  const windEastMps = Math.sin(windTowardRad) * windSpeedMps;

  const airNorthMps = point.velNMps - windNorthMps;
  const airEastMps = point.velEMps - windEastMps;

  const calculatedAirspeedMps = correctedHorizontalSpeedsMps?.[index] ?? Math.sqrt(
    airNorthMps * airNorthMps + airEastMps * airEastMps
  );

  const useCorrectedGraphValues = scoreMode === "corrected" && windsAvailable;

const displayHorizontalSpeedMps = useCorrectedGraphValues && correctedHorizontalSpeedsMps ? calculatedAirspeedMps : getDisplayHorizontalSpeedMps(
  point,
  winds,
  useCorrectedGraphValues
);

const displayTotalSpeedMps = useCorrectedGraphValues && correctedHorizontalSpeedsMps ? Math.hypot(calculatedAirspeedMps, point.verticalSpeedMps) : getDisplayTotalSpeedMps(
  point,
  winds,
  useCorrectedGraphValues
);

const displayGlideRatio = useCorrectedGraphValues && correctedHorizontalSpeedsMps ? (point.verticalSpeedMps > 0 ? calculatedAirspeedMps / point.verticalSpeedMps : null) : getDisplayGlideRatio(
  point,
  winds,
  useCorrectedGraphValues
);

const diveAngleDeg =
  displayHorizontalSpeedMps > 0
    ? Math.atan2(point.verticalSpeedMps, displayHorizontalSpeedMps) *
      (180 / Math.PI)
    : 0;

  return {
    sample: index,
    timeSeconds: recordedTimes?.[index] ?? index * GPS_SAMPLE_PERIOD_SECONDS,
    altitudeM: point.altitudeM,
    horizontalSpeedKmh: metresPerSecondToKmh(
      displayHorizontalSpeedMps),
    verticalSpeedKmh: metresPerSecondToKmh(
      point.verticalSpeedMps
    ),
    totalSpeedKmh: metresPerSecondToKmh(
      displayTotalSpeedMps),
    calculatedAirspeedKmh: metresPerSecondToKmh(
      calculatedAirspeedMps
    ),
    glideRatio: displayGlideRatio,
    diveAngleDeg,
    windDirectionFromDeg,
    windSpeedKt,
  };
});

  type ChartMouseState = {
    activeLabel?: string | number;
  };

  type TouchPoint = {
    x: number;
    y: number;
  };

  const totalMinTime = chartData[0]?.timeSeconds ?? 0;
  const lastTime = chartData.at(-1)?.timeSeconds ?? totalMinTime;
  const totalMaxTime = lastTime > totalMinTime ? lastTime : totalMinTime + 1;
  const totalTimeSpan = totalMaxTime - totalMinTime;
  const PINCH_ZOOM_SENSITIVITY = 2.6;
  const minimumZoomSpan = Math.max(totalTimeSpan / 500, GPS_SAMPLE_PERIOD_SECONDS * 8);
  const [visibleDomain, setVisibleDomain] = useState<[number, number] | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [dragMode, setDragMode] = useState<"measure" | "zoom">("measure");
  const [measuredRange, setMeasuredRange] = useState<[number, number] | null>(null);
  const measurement = measuredRange ? measureChartRange(chartData, ...measuredRange) : null;
  const [isPinching, setIsPinching] = useState(false);
  const touchPointsRef = useRef<Map<number, TouchPoint>>(new Map());
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartDomainRef = useRef<[number, number] | null>(null);
  const pendingPinchDomainRef = useRef<[number, number] | null>(null);

  const trackRangeKey =
    String(points.length) + ":" +
    String(points[0]?.timestampMs ?? "start") + ":" +
    String(points.at(-1)?.timestampMs ?? "end");

  useEffect(() => {
    setVisibleDomain(null);
    setMeasuredRange(null);
    setSelectionStart(null);
    setSelectionEnd(null);
    setIsPinching(false);
    touchPointsRef.current.clear();
    pinchStartDistanceRef.current = null;
    pinchStartDomainRef.current = null;
    pendingPinchDomainRef.current = null;
  }, [trackRangeKey]);

  const activeDomain = visibleDomain ?? [totalMinTime, totalMaxTime];
  const isZoomed =
    activeDomain[0] > totalMinTime || activeDomain[1] < totalMaxTime;

  function clampDomain(start: number, end: number): [number, number] {
    let nextStart = Math.max(totalMinTime, Math.min(start, totalMaxTime));
    let nextEnd = Math.max(totalMinTime, Math.min(end, totalMaxTime));

    if (nextEnd - nextStart < minimumZoomSpan) {
      const center = (nextStart + nextEnd) / 2;
      nextStart = center - minimumZoomSpan / 2;
      nextEnd = center + minimumZoomSpan / 2;
    }

    if (nextStart < totalMinTime) {
      nextEnd += totalMinTime - nextStart;
      nextStart = totalMinTime;
    }

    if (nextEnd > totalMaxTime) {
      nextStart -= nextEnd - totalMaxTime;
      nextEnd = totalMaxTime;
    }

    return [
      Math.max(totalMinTime, nextStart),
      Math.min(totalMaxTime, nextEnd),
    ];
  }

  function getZoomDomain(
    centerTime: number,
    scale: number,
    domain: [number, number] = activeDomain
  ): [number, number] {
    const [currentStart, currentEnd] = domain;
    const currentSpan = currentEnd - currentStart;
    const nextSpan = Math.max(
      minimumZoomSpan,
      Math.min(totalTimeSpan, currentSpan * scale)
    );
    const centerRatio =
      currentSpan > 0 ? (centerTime - currentStart) / currentSpan : 0.5;
    const nextStart = centerTime - nextSpan * centerRatio;
    const nextEnd = nextStart + nextSpan;
    return clampDomain(nextStart, nextEnd);
  }

  function zoomAround(centerTime: number, scale: number) {
    setVisibleDomain(getZoomDomain(centerTime, scale));
  }

  function getChartPlotBounds(chartElement: HTMLDivElement) {
    const svg = chartElement.querySelector("svg");
    const gridLine = chartElement.querySelector(
      ".recharts-cartesian-grid-horizontal line"
    );

    if (!(svg instanceof SVGSVGElement) || !(gridLine instanceof SVGLineElement)) {
      const rect = chartElement.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    }

    const svgRect = svg.getBoundingClientRect();
    const viewBoxWidth = svg.viewBox.baseVal.width || svgRect.width;
    const scaleX = svgRect.width / viewBoxWidth;
    const x1 = Number(gridLine.getAttribute("x1"));
    const x2 = Number(gridLine.getAttribute("x2"));

    if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) {
      return { left: svgRect.left, width: svgRect.width };
    }

    return {
      left: svgRect.left + x1 * scaleX,
      width: (x2 - x1) * scaleX,
    };
  }

  function getTimeFromChartPosition(
    clientX: number,
    chartElement: HTMLDivElement,
    domain: [number, number] = activeDomain
  ) {
    const plotBounds = getChartPlotBounds(chartElement);
    const progress = Math.max(
      0,
      Math.min(1, (clientX - plotBounds.left) / plotBounds.width)
    );
    return domain[0] + progress * (domain[1] - domain[0]);
  }

  function getNumericLabel(state: ChartMouseState | undefined) {
    if (state?.activeLabel === undefined || state.activeLabel === "") return null;
    const value = Number(state.activeLabel);
    return Number.isFinite(value) ? value : null;
  }

  function handleChartMouseDown(state: ChartMouseState | undefined) {
    if (exitSelectionMode || isPinching) {
      return;
    }

    const label = getNumericLabel(state);

    if (label === null) {
      return;
    }

    setSelectionStart(label);
    setSelectionEnd(label);
  }

  function handleChartMouseMove(state: ChartMouseState | undefined) {
    if (exitSelectionMode || isPinching || selectionStart === null) {
      return;
    }

    const label = getNumericLabel(state);

    if (label !== null) {
      setSelectionEnd(label);
    }
  }

  function finishChartSelection() {
    if (isPinching) return;
    if (exitSelectionMode) {
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    if (selectionStart === null || selectionEnd === null) {
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    const nextStart = Math.min(selectionStart, selectionEnd);
    const nextEnd = Math.max(selectionStart, selectionEnd);

    if (dragMode === "measure") {
      if (nextEnd > nextStart) setMeasuredRange([nextStart, nextEnd]);
    } else if (nextEnd - nextStart >= minimumZoomSpan) {
      setVisibleDomain(clampDomain(nextStart, nextEnd));
    }

    setSelectionStart(null);
    setSelectionEnd(null);
  }

  function resetZoom() {
    setVisibleDomain(null);
    setSelectionStart(null);
    setSelectionEnd(null);
  }

  function handleExitPointClick(state: ChartMouseState | undefined) {
    if (!exitSelectionMode || !onExitPointSelect) {
      return;
    }

    const label = getNumericLabel(state);

    if (label === null) {
      return;
    }

    const selectedIndex = Math.max(
      0,
      Math.min(
        points.length - 1,
        Math.round(label / GPS_SAMPLE_PERIOD_SECONDS),
      ),
    );
    const selectedPoint = points[selectedIndex];

    if (selectedPoint) {
      onExitPointSelect(selectedPoint);
    }
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const centerTime = getTimeFromChartPosition(event.clientX, event.currentTarget);
    const wheelStep = Math.max(-1, Math.min(1, event.deltaY / 240));
    const scale = Math.exp(wheelStep * 0.012);
    zoomAround(centerTime, scale);
  }

  function previewPinchDomain(chartElement: HTMLDivElement) {
    const nextDistance = getTouchDistance();
    const startDistance = pinchStartDistanceRef.current;
    const startDomain = pinchStartDomainRef.current;

    if (nextDistance === null || startDistance === null || startDomain === null) {
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    const centerClientX = getTouchCenterX();
    const centerTime = getTimeFromChartPosition(
      centerClientX,
      chartElement,
      startDomain
    );
    const distanceRatio = nextDistance / startDistance;
    const zoomScale = Math.pow(distanceRatio, PINCH_ZOOM_SENSITIVITY);
    const nextDomain = getZoomDomain(centerTime, zoomScale, startDomain);
    pendingPinchDomainRef.current = nextDomain;
    setSelectionStart(nextDomain[0]);
    setSelectionEnd(nextDomain[1]);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return;
    }

    touchPointsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (touchPointsRef.current.size >= 2) {
      setIsPinching(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      pinchStartDistanceRef.current = getTouchDistance();
      pinchStartDomainRef.current = activeDomain;
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || !touchPointsRef.current.has(event.pointerId)) {
      return;
    }

    touchPointsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (touchPointsRef.current.size < 2) {
      return;
    }

    const nextDistance = getTouchDistance();

    if (nextDistance === null || nextDistance <= 0) {
      return;
    }

    event.preventDefault();
    previewPinchDomain(event.currentTarget);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return;
    }

    touchPointsRef.current.delete(event.pointerId);

    if (touchPointsRef.current.size < 2) {
      if (pendingPinchDomainRef.current) {
        setVisibleDomain(pendingPinchDomainRef.current);
      }

      setIsPinching(false);
      pinchStartDistanceRef.current = null;
      pinchStartDomainRef.current = null;
      pendingPinchDomainRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
    }
  }

  function getTouchPoints() {
    return Array.from(touchPointsRef.current.values()).slice(0, 2);
  }

  function getTouchDistance() {
    const [first, second] = getTouchPoints();

    if (!first || !second) {
      return null;
    }

    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function getTouchCenterX() {
    const [first, second] = getTouchPoints();

    if (!first || !second) {
      return 0;
    }

    return (first.x + second.x) / 2;
  }

  const windowTopM = 2500 + windowOffsetM;
  const windowBottomM = 1500 + windowOffsetM;

  return (
    <section className="card">
      <div className="interactive-chart-heading">
        <div>
          <h2>Interactive Flight Graph</h2>

          <p className="subtitle">
            {exitSelectionMode
              ? "Tap or click the point where you start the competition dive."
              : dragMode === "measure"
                ? "Click and drag across the graph to measure a section. Pinch to zoom."
                : "Drag across the graph to zoom into a range. Pinch to zoom."}
          </p>

          <p className="chart-rotate-hint">
            Rotate your phone for a larger interactive graph.
          </p>
        </div>

        {(showViewControls || showScoreModeControl) && (
          <div
            className={
              "chart-control-row" +
              (showCompetitionContext ? "" : " chart-control-row-score-only")
            }
          >
            {showViewControls && (
              <button
                type="button"
                className={
                  "graph-view-button graph-view-button-left " +
                  (graphView === "comp" ? "active" : "")
                }
                onClick={() => onGraphViewChange("comp")}
                aria-pressed={graphView === "comp"}
              >
                Comp run
              </button>
            )}

            {showScoreModeControl && (
              <label className="score-mode-switch graph-score-mode-switch">
                <span className={scoreMode === "raw" ? "active" : ""}>Raw</span>

                <input
                  type="checkbox"
                  checked={scoreMode === "corrected"}
                  onChange={(event) =>
                    onScoreModeChange(event.target.checked ? "corrected" : "raw")
                  }
                  disabled={!windsAvailable}
                />

                <span className="score-mode-track">
                  <span className="score-mode-knob" />
                </span>

                <span className={scoreMode === "corrected" ? "active" : ""}>
                  Corrected
                </span>
              </label>
            )}

            {showViewControls && (
              <button
                type="button"
                className={
                  "graph-view-button graph-view-button-right " +
                  (graphView === "full" ? "active" : "")
                }
                onClick={() => onGraphViewChange("full")}
                aria-pressed={graphView === "full"}
              >
                Full Jump
              </button>
            )}
          </div>
        )}

        {!exitSelectionMode && (
          <div className="chart-measure-controls" role="group" aria-label="Graph drag action">
            {(["measure", "zoom"] as const).map(mode => (
              <button key={mode} type="button" className="chart-reset-button" aria-pressed={dragMode === mode}
                onClick={() => { setDragMode(mode); setSelectionStart(null); setSelectionEnd(null); }}>
                {mode === "measure" ? "Measure range" : "Zoom range"}
              </button>
            ))}
            {measuredRange && <button type="button" className="chart-reset-button" onClick={() => setMeasuredRange(null)}>Clear measurement</button>}
          </div>
        )}

        {isZoomed && (
          <button
            type="button"
            className="chart-reset-button"
            onClick={resetZoom}
          >
            Reset zoom
          </button>
        )}
      </div>

      {measurement && !exitSelectionMode && (
        <div className="chart-measurement" role="status">
          <strong>Selected section: {measurement.start.toFixed(1)}–{measurement.end.toFixed(1)} s ({(measurement.end - measurement.start).toFixed(1)} s)</strong>
          <p>Time-weighted averages · {scoreMode === "corrected" && windsAvailable ? "Corrected" : "Raw"} graph values</p>
          <dl>
            {measurement.averages.map(metric => (
              <Fragment key={metric.key}>
              <div>
                <dt>Average {metric.label}</dt>
                  <dd>{metric.key === "calculatedAirspeedKmh" && !windsAvailable ? "Unavailable" : metric.value === null ? "—" : metric.value.toFixed(metric.digits) + metric.unit}</dd>
              </div>
              {metric.key === "diveAngleDeg" && <div><dt>Altitude change</dt><dd>{measurement.altitudeChangeM > 0 ? "+" : ""}{measurement.altitudeChangeM.toFixed(1)} m</dd></div>}
              </Fragment>
            ))}
          </dl>
          <p>Altitude change is end minus start; negative means descent. Corrected speed is calculated horizontal airspeed.</p>
        </div>
      )}

      {exitSelectionMode && (
        <div className="exit-selection-banner" role="status">
          <p>Tap the graph where your competition dive starts.</p>

          {onCancelExitSelection && (
            <button type="button" onClick={onCancelExitSelection}>
              Cancel
            </button>
          )}
        </div>
      )}

      <div
        className={
          "interactive-chart-wrap" +
          (exitSelectionMode ? " exit-selection-active" : "")
        }
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 320, height: 460 }}
        >
          <LineChart
            data={chartData}
            margin={{ top: 20, right: 28, bottom: 20, left: 12 }}
            onMouseDown={handleChartMouseDown}
            onMouseMove={handleChartMouseMove}
            onMouseUp={finishChartSelection}
            onMouseLeave={finishChartSelection}
            onClick={handleExitPointClick}
          >
            <CartesianGrid
              stroke="rgba(148, 163, 184, 0.22)"
              strokeDasharray="4 4"
            />

            <XAxis
              dataKey="timeSeconds"
              type="number"
              domain={activeDomain}
              allowDataOverflow
              tickFormatter={(value) => String(Number(value).toFixed(0)) + "s"}
              stroke="#d1d5db"
            />

            <YAxis
              yAxisId="altitude"
              stroke="#d1d5db"
              tickFormatter={(value) => String(Number(value).toFixed(0)) + " m"}
            />

            <YAxis
              yAxisId="speed"
              orientation="right"
              stroke="#2563eb"
              tickFormatter={(value) => String(Number(value).toFixed(0))}
            />

            <YAxis
              yAxisId="glideRatio"
              hide
              type="number"
              domain={[0, 8]}
              allowDataOverflow
            />

            <YAxis
              yAxisId="diveAngle"
              hide
              domain={[0, "auto"]}
            />

            <Tooltip
              active={isPinching ? false : undefined}
              contentStyle={{
                background: "rgba(2, 6, 23, 0.2)",
                border: "1px solid #22d3ee",
                borderRadius: "12px",
                color: "#ffffff",
              }}
              labelFormatter={(value) =>
                "Time: " + Number(value).toFixed(1) + " sec"
              }
              formatter={(value, name) => {
                const numericValue = Number(value);

                const labels: Record<string, string> = {
                  altitudeM: "Altitude",
                  horizontalSpeedKmh: "Horizontal Speed",
                  verticalSpeedKmh: "Vertical Speed",
                  totalSpeedKmh: "Total Speed",
                  calculatedAirspeedKmh: "Calculated Airspeed",
                  glideRatio: "Glide Ratio",
                  diveAngleDeg: "Dive Angle",
                };

                const units: Record<string, string> = {
                  altitudeM: " m",
                  horizontalSpeedKmh: " km/h",
                  verticalSpeedKmh: " km/h",
                  totalSpeedKmh: " km/h",
                  calculatedAirspeedKmh: " km/h",
                  glideRatio: "",
                  diveAngleDeg: " deg",
                };

                return [
                  String(numericValue.toFixed(1)) + (units[String(name)] ?? ""),
                  labels[String(name)] ?? String(name),
                ];
              }}
            />

            {playbackPosition !== undefined && (
              <ReferenceLine yAxisId="altitude" x={playbackPosition} stroke="#f97316" strokeWidth={2} />
            )}
            {competitionWindowTimes && <>
              <ReferenceLine yAxisId="altitude" x={competitionWindowTimes.start} stroke="#22c55e" strokeWidth={2} strokeDasharray="6 4"
                label={{value:"Window start",position:"insideTopRight",fill:"#22c55e",fontSize:12}} />
              <ReferenceLine yAxisId="altitude" x={competitionWindowTimes.end} stroke="#ef4444" strokeWidth={2} strokeDasharray="6 4"
                label={{value:"Window end",position:"insideTopLeft",fill:"#ef4444",fontSize:12}} />
            </>}
            {measuredRange && !exitSelectionMode && (
              <ReferenceArea yAxisId="altitude" x1={measuredRange[0]} x2={measuredRange[1]}
                stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.16} />
            )}
            {selectionStart !== null && selectionEnd !== null && (
              <ReferenceArea
                yAxisId="altitude"
                x1={Math.min(selectionStart, selectionEnd)}
                x2={Math.max(selectionStart, selectionEnd)}
                stroke="#22d3ee"
                strokeOpacity={0.8}
                fill="#22d3ee"
                fillOpacity={0.18}
              />
            )}

            {showCompetitionContext && (
              <>
                <ReferenceLine
                  yAxisId="altitude"
                  y={windowTopM}
                  stroke="#22c55e"
                  strokeDasharray="6 4"
                  label={{
                    value: String(windowTopM) + " m",
                    fill: "#22c55e",
                    position: "insideTopRight",
                  }}
                />

                <ReferenceLine
                  yAxisId="altitude"
                  y={windowBottomM}
                  stroke="#ef4444"
                  strokeDasharray="6 4"
                  label={{
                    value: String(windowBottomM) + " m",
                    fill: "#ef4444",
                    position: "insideBottomRight",
                  }}
                />
              </>
            )}

<Line
  yAxisId="altitude"
  type="monotone"
  dataKey="altitudeM"
  name="Elevation"
  stroke="#d1d5db"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="horizontalSpeedKmh"
  name="Horizontal Speed"
  stroke="#ef4444"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="verticalSpeedKmh"
  name="Vertical Speed"
  stroke="#22c55e"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="speed"
  type="monotone"
  dataKey="totalSpeedKmh"
  name="Total Speed"
  stroke="#2563eb"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

{(!hideAirspeedWithoutWinds || windsAvailable) && <Line
  yAxisId="speed"
  type="monotone"
  dataKey="calculatedAirspeedKmh"
  name="Calculated Airspeed"
  stroke="#f97316"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>

}
<Line
  yAxisId="glideRatio"
  type="monotone"
  dataKey="glideRatio"
  name="Glide Ratio"
  stroke="#0d9488"
  strokeWidth={2.5}
  dot={false}
  connectNulls
  activeDot={{ r: 5 }}
/>

<Line
  yAxisId="diveAngle"
  type="monotone"
  dataKey="diveAngleDeg"
  name="Dive Angle"
  stroke="#f0f"
  strokeWidth={2.5}
  dot={false}
  activeDot={{ r: 5 }}
/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              );
            }
