import {useEffect,useMemo,useRef} from "react";
import maplibregl from "maplibre-gl";
import {bearingBetweenPointsDeg,buildLanePolygon,buildLaneStripPolygon,degToRad,destinationPoint,nmToMetres,normalizeDeg,signedAngleDeg} from "./flight/geo";
import type {LatLon} from "./flight/geo";
import {numberFromInput} from "./flightChartMath";
import type {WindLayer} from "./flightChartMath";
export type LaneMapPoint = LatLon & {altitudeM:number};
import type {SavedReferencePoint} from "./referencePoints";
import "maplibre-gl/dist/maplibre-gl.css";
import "./CompetitionLane.css";
const NO_TRACK_POINTS:LaneMapPoint[]=[];
const NO_SAVED_REFERENCE_POINTS:SavedReferencePoint[]=[];
function optionalNumberFromInput(value:string):number|null {if(!value.trim())return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}

export default function LaneViewMap({
  referenceLat,
  referenceLon,
  dropPoint,
  runHeadingDeg,
  dropDistanceNm,
  winds,
  trackPoints = NO_TRACK_POINTS,
  windowPoints = NO_TRACK_POINTS,
  onPick,
  savedReferencePoints = NO_SAVED_REFERENCE_POINTS,
  onSavedReferencePointPick,
}: {
  referenceLat: string;
  referenceLon: string;
  dropPoint: LatLon | null;
  runHeadingDeg: string;
  dropDistanceNm: string;
  winds: WindLayer[];
  trackPoints?: LaneMapPoint[];
  windowPoints?: LaneMapPoint[];
  onPick?: (lat: number, lon: number) => void;
  savedReferencePoints?: SavedReferencePoint[];
  onSavedReferencePointPick?: (point: SavedReferencePoint) => void;
}) {
  
  const mapContainerRef = useMemo(
    () => ({ current: null as HTMLDivElement | null }),
    []
  );

  const pickRef = useRef(onPick);
  const savedPickRef = useRef(onSavedReferencePointPick);
  pickRef.current = onPick;
  savedPickRef.current = onSavedReferencePointPick;

  useEffect(() => {
    const isAnalysis = windowPoints.length > 1;
    const hasReference = optionalNumberFromInput(referenceLat) !== null &&
      optionalNumberFromInput(referenceLon) !== null;
    const flightEnd = windowPoints[windowPoints.length - 1];
    const lat = optionalNumberFromInput(referenceLat) ?? flightEnd?.lat ?? null;
    const lon = optionalNumberFromInput(referenceLon) ?? flightEnd?.lon ?? null;
    const headingNumber = optionalNumberFromInput(runHeadingDeg) ?? (isAnalysis
      ? bearingBetweenPointsDeg(windowPoints[0].lat, windowPoints[0].lon, flightEnd.lat, flightEnd.lon)
      : null);

    if (
      lat === null ||
      lon === null ||
      dropPoint === null ||
      headingNumber === null ||
      mapContainerRef.current === null
    ) {
      return;
    }

    const referencePoint = { lat, lon };
    const viewBearing = isAnalysis ? 0 : headingNumber;
    const flightBearing = isAnalysis
      ? bearingBetweenPointsDeg(windowPoints[0].lat, windowPoints[0].lon, flightEnd.lat, flightEnd.lon)
      : headingNumber;
    const windsBelowLane = Math.abs(Math.sin(degToRad(flightBearing))) >=
      Math.abs(Math.cos(degToRad(flightBearing)));

    function windPosition(wind: WindLayer) {
      if (isAnalysis) {
        for (let index = 1; index < windowPoints.length; index += 1) {
          const before = windowPoints[index - 1];
          const after = windowPoints[index];
          if (before.altitudeM >= wind.altitudeM && after.altitudeM <= wind.altitudeM) {
            const progress = before.altitudeM === after.altitudeM ? 0 :
              (before.altitudeM - wind.altitudeM) / (before.altitudeM - after.altitudeM);
            return {
              lat: before.lat + (after.lat - before.lat) * progress,
              lon: before.lon + (after.lon - before.lon) * progress,
            };
          }
        }
        return wind.altitudeM >= windowPoints[0].altitudeM
          ? windowPoints[0] : windowPoints[windowPoints.length - 1];
      }
      const progress = Math.min(Math.max((2500 - wind.altitudeM) / 1000, 0), 1);
      const lanePoint = destinationPoint(dropPoint!.lat, dropPoint!.lon, headingNumber!,
        nmToMetres(numberFromInput(dropDistanceNm, 0)) * progress);
      return destinationPoint(lanePoint.lat, lanePoint.lon, normalizeDeg(headingNumber! - 90), 600);
    }

    const center: [number, number] = [
      (lon + dropPoint.lon) / 2,
      (lat + dropPoint.lat) / 2,
    ];

    function toMapLibrePolygon(points: [number, number][]) {
      return points.map(([pointLat, pointLon]) => [pointLon, pointLat]);
    }

    function makePolygonFeature(points: [number, number][]) {
      return {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[...toMapLibrePolygon(points), toMapLibrePolygon(points)[0]]],
        },
      };
    }

    const leftRedLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      450,
      600,
      "left"
    );

    const rightRedLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      450,
      600,
      "right"
    );

    const leftYellowLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300,
      450,
      "left"
    );

    const rightYellowLanePolygon = buildLaneStripPolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300,
      450,
      "right"
    );

    const greenLanePolygon = buildLanePolygon(
      dropPoint,
      referencePoint,
      headingNumber,
      300
    );

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: [
              "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            attribution:
              "Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          },
        },
        layers: [
          {
            id: "satellite",
            type: "raster",
            source: "satellite",
          },
        ],
      },
      center,
      zoom: 12,
      bearing: viewBearing,
      pitch: 0,
    });

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(mapContainerRef.current);

    if (isAnalysis) {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.touchPitch.disable();
    }

    map.on("click", (event) => {
      pickRef.current?.(event.lngLat.lat, event.lngLat.lng);
    });
    if (pickRef.current) map.getCanvas().style.cursor = "crosshair";

    let handleLaneWheel: ((event: WheelEvent) => void) | null = null;
    map.on("load", () => {

      const bounds = new maplibregl.LngLatBounds();

      (hasReference ? [
        ...leftRedLanePolygon,
        ...rightRedLanePolygon,
        ...leftYellowLanePolygon,
        ...rightYellowLanePolygon,
        ...greenLanePolygon,
      ] : []).forEach(([pointLat, pointLon]) => {
        bounds.extend([pointLon, pointLat]);
      });

      trackPoints.forEach((point) => bounds.extend([point.lon, point.lat]));
      winds.forEach((wind) => {
        const windEdgePoint = windPosition(wind);
        bounds.extend([windEdgePoint.lon, windEdgePoint.lat]);
      });

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          bearing: viewBearing,
          padding: {
            top: 45,
            bottom: isAnalysis && windsBelowLane ? 190 : 85,
            left: isAnalysis && !windsBelowLane ? 200 : 105,
            right: 85,
          },
          duration: 0,
        });

        map.setBearing(viewBearing);
        map.setPitch(0);

        const laneCenter = bounds.getCenter();

        map.scrollZoom.disable();

        handleLaneWheel = (event: WheelEvent) => {
          event.preventDefault();

          const zoomStep = 0.12;
          const direction = event.deltaY > 0 ? -1 : 1;

          const nextZoom = Math.max(
            map.getMinZoom(),
            Math.min(map.getMaxZoom(), map.getZoom() + direction * zoomStep)
          );

          map.easeTo({
            center: laneCenter,
            zoom: nextZoom,
            bearing: viewBearing,
            pitch: 0,
            duration: 100,
          });
        };

        map
          .getCanvasContainer()
          .addEventListener("wheel", handleLaneWheel, {
            passive: false,
          });
      }
      if (hasReference) {
      map.addSource("lane-red-left", {
        type: "geojson",
        data: makePolygonFeature(leftRedLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-red-right", {
        type: "geojson",
        data: makePolygonFeature(rightRedLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-yellow-left", {
        type: "geojson",
        data: makePolygonFeature(leftYellowLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-yellow-right", {
        type: "geojson",
        data: makePolygonFeature(rightYellowLanePolygon) as GeoJSON.Feature,
      });

      map.addSource("lane-green-outline", {
        type: "geojson",
        data: makePolygonFeature(greenLanePolygon) as GeoJSON.Feature,
      });

      map.addLayer({
        id: "lane-red-left-fill",
        type: "fill",
        source: "lane-red-left",
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.18,
        },
      });

      map.addLayer({
        id: "lane-red-right-fill",
        type: "fill",
        source: "lane-red-right",
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.18,
        },
      });

      map.addLayer({
        id: "lane-yellow-left-fill",
        type: "fill",
        source: "lane-yellow-left",
        paint: {
          "fill-color": "#facc15",
          "fill-opacity": 0.22,
        },
      });

      map.addLayer({
        id: "lane-yellow-right-fill",
        type: "fill",
        source: "lane-yellow-right",
        paint: {
          "fill-color": "#facc15",
          "fill-opacity": 0.22,
        },
      });

      map.addLayer({
        id: "lane-green-outline-line",
        type: "line",
        source: "lane-green-outline",
        paint: {
          "line-color": "#22c55e",
          "line-width": 3,
          "line-opacity": 0.95,
        },
      });

      }

      if (trackPoints.length > 1) {
        map.addSource("flown-track", {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: {
            type: "LineString", coordinates: trackPoints.map((point) => [point.lon, point.lat]),
          } },
        });
        map.addLayer({ id: "flown-track", type: "line", source: "flown-track",
          paint: { "line-color": "#22d3ee", "line-width": 4 } });
      }

      const mapBearingDeg = normalizeDeg(headingNumber + 180);

      const analysisWindMarkers: { marker: maplibregl.Marker; point: LatLon; element: HTMLElement }[] = [];
      winds.forEach((wind) => {
        const markerPoint = windPosition(wind);

        const windSpeedKt = Math.round(numberFromInput(wind.speedKt, 0));
        const windFromDeg = Math.round(numberFromInput(wind.directionFromDeg, 0));

        // Show the direction the wind is travelling toward, corrected for the rotated map.
        const windTowardDeg = normalizeDeg(windFromDeg + 180);
        const windScreenRotationDeg =
          signedAngleDeg(mapBearingDeg, windTowardDeg) + 90;

        const markerElement = document.createElement("div");
        markerElement.className = isAnalysis ? "lane-wind-marker analysis-lane-wind" : "lane-wind-marker";
        markerElement.innerHTML = `
          <div class="lane-wind-speed">${isAnalysis ? `${wind.altitudeM} m · ` : ""}${windSpeedKt} kt</div>
          <div
            class="lane-wind-arrow"
            style="transform: rotate(${windScreenRotationDeg}deg);"
          >
            ➜
          </div>
        `;
        if (isAnalysis) {
          const arrow = markerElement.querySelector<HTMLElement>(".lane-wind-arrow")!;
          const updateArrow = () => {
            arrow.style.transform = `rotate(${windTowardDeg - map.getBearing() - 90}deg)`;
          };
          updateArrow();
          map.on("rotate", updateArrow);
          markerElement.title = `${wind.altitudeM} m: ${windSpeedKt} kt from ${windFromDeg}°`;
        }
        const windMarker = new maplibregl.Marker({
          element: markerElement,
          rotationAlignment: "viewport",
          anchor: isAnalysis ? "left" : "right",
          offset: isAnalysis ? [8, 0] : [-8, 0],
})
  .setLngLat([markerPoint.lon, markerPoint.lat])
  .addTo(map);
        if (isAnalysis) {
          analysisWindMarkers.push({ marker: windMarker, point: markerPoint, element: markerElement });
        }
      });

      if (isAnalysis && analysisWindMarkers.length > 0) {
        map.addSource("wind-label-connectors", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "wind-label-connectors", type: "line", source: "wind-label-connectors",
          paint: { "line-color": "#cbd5e1", "line-width": 1, "line-opacity": 0.6 },
        });
        const positionWindLabels = () => {
          const labels = analysisWindMarkers.map((entry) => ({
            ...entry,
            anchor: map.project([entry.point.lon, entry.point.lat]),
            height: entry.element.offsetHeight || 42,
            width: entry.element.offsetWidth || 150,
            x: 0,
            y: 0,
          })).sort((a, b) => windsBelowLane ? a.anchor.x - b.anchor.x : a.anchor.y - b.anchor.y);
          const perimeter = [
            ...trackPoints.map((point) => map.project([point.lon, point.lat])),
            ...(hasReference ? [...leftRedLanePolygon, ...rightRedLanePolygon, ...greenLanePolygon]
              .map(([lat, lon]) => map.project([lon, lat])) : []),
            ...labels.map((label) => label.anchor),
          ];
          const bottom = Math.max(...perimeter.map((point) => point.y));
          const left = Math.min(...perimeter.map((point) => point.x));
          if (windsBelowLane) {
            // Retain each altitude's east/west position; stagger only colliding boxes.
            const rowEnds: number[] = [];
            const rowHeight = Math.max(...labels.map((label) => label.height)) + 10;
            labels.forEach((label) => {
              label.x = Math.max(12, Math.min(map.getContainer().clientWidth - label.width - 12,
                label.anchor.x - label.width / 2));
              let row = rowEnds.findIndex((end) => end + 10 <= label.x);
              if (row === -1) row = rowEnds.length;
              rowEnds[row] = label.x + label.width;
              label.y = bottom + 24 + label.height / 2 + row * rowHeight;
            });
          } else {
            labels.forEach((label, index) => {
              const previous = labels[index - 1];
              label.x = left - 24 - label.width;
              label.y = Math.max(label.anchor.y, previous
                ? previous.y + (previous.height + label.height) / 2 + 10
                : label.height / 2 + 12);
            });
            const last = labels[labels.length - 1];
            const overflow = Math.max(0, last.y + last.height / 2 + 12 - map.getContainer().clientHeight);
            labels.forEach((label) => { label.y -= overflow; });
            const topOverflow = Math.max(0, labels[0].height / 2 + 12 - labels[0].y);
            labels.forEach((label) => { label.y += topOverflow; });
          }
          const features: GeoJSON.Feature<GeoJSON.LineString>[] = labels.map((label) => {
            label.marker.setOffset([label.x - label.anchor.x, label.y - label.anchor.y]);
            const end = map.unproject(windsBelowLane
              ? [label.x + label.width / 2, label.y - label.height / 2 - 4]
              : [label.x + label.width + 4, label.y]);
            return { type: "Feature", properties: {}, geometry: {
              type: "LineString", coordinates: [[label.point.lon, label.point.lat], [end.lng, end.lat]],
            } };
          });
          (map.getSource("wind-label-connectors") as maplibregl.GeoJSONSource)
            .setData({ type: "FeatureCollection", features });
        };
        positionWindLabels();
        map.on("move", positionWindLabels);
        map.on("resize", positionWindLabels);
      }

      if (hasReference) {
        new maplibregl.Marker({ color: "#22d3ee" })
          .setLngLat([lon, lat]).addTo(map);
      }
      savedReferencePoints.forEach((point) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "analysis-reference-marker";
        element.textContent = point.name;
        element.setAttribute("aria-label", `Choose ${point.name}`);
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          savedPickRef.current?.(point);
        });
        new maplibregl.Marker({ element, anchor: "bottom", offset: [0, -35] })
          .setLngLat([point.lon, point.lat]).addTo(map);
      });
    });

    return () => {
      resizeObserver.disconnect();
      map.remove();
    };
  }, [
  referenceLat,
  referenceLon,
  dropPoint,
  runHeadingDeg,
  dropDistanceNm,
  winds,
  mapContainerRef,
  trackPoints,
  windowPoints,
  savedReferencePoints,
]);

  return <div ref={mapContainerRef} className="lane-view-map" />;
}
