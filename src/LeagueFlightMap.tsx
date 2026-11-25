import { useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import type { LeagueReferencePoint } from "./leagueReference";
import "leaflet/dist/leaflet.css";
import "./LeagueFlightMap.css";

export type FlightMapPoint = { lat: number; lon: number; altitudeM: number };
function MapBehaviour({ points, reference, onPick }: {
  points: FlightMapPoint[]; reference: LeagueReferencePoint | null;
  onPick?: (point: LeagueReferencePoint) => void;
}) {
  const map = useMap();
  useMapEvents({ click: event => onPick?.({name: reference?.name || "Reference point", lat: event.latlng.lat, lon: event.latlng.lng}) });
  useEffect(() => {
    const bounds: [number, number][] = points.map(p => [p.lat, p.lon]);
    if (reference) bounds.push([reference.lat, reference.lon]);
    if (bounds.length) map.fitBounds(bounds, {padding: [32, 32], maxZoom: 15});
    const timer = setTimeout(() => map.invalidateSize(), 100);
    return () => clearTimeout(timer);
  }, [map, points, reference]);
  return null;
}
export default function LeagueFlightMap({points, reference, onPick}: {
  points: FlightMapPoint[]; reference: LeagueReferencePoint | null;
  onPick?: (point: LeagueReferencePoint) => void;
}) {
  const path = points.map(p => [p.lat, p.lon] as [number, number]);
  const scoringPath = points.filter(p => p.altitudeM <= 2500 && p.altitudeM >= 1500)
    .map(p => [p.lat, p.lon] as [number, number]);
  return <div className="league-flight-map" aria-label={onPick ? "Select your flight reference point on the map" : "Flight track and selected reference point"}>
    <MapContainer center={path[0] ?? [-25, 134]} zoom={path.length ? 12 : 4} scrollWheelZoom={false}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'} />
      <MapBehaviour points={points} reference={reference} onPick={onPick} />
      {path.length > 1 && <Polyline positions={path} pathOptions={{color: "#0e7490", weight: 4}} />}
      {scoringPath.length > 1 && <Polyline positions={scoringPath} pathOptions={{color: "#e87912", weight: 5}} />}
      {path[0] && <CircleMarker center={path[0]} radius={6} pathOptions={{color: "#14532d", fillOpacity: 1}}><Popup>Exit / start of displayed flight</Popup></CircleMarker>}
      {reference && <>
        {path[0] && <Polyline positions={[path[0], [reference.lat, reference.lon]]} pathOptions={{color: "#6750a4", dashArray: "6 6", weight: 2}} />}
        <CircleMarker center={[reference.lat, reference.lon]} radius={9} pathOptions={{color: "#6750a4", fillOpacity: 1}}><Popup>{reference.name}</Popup></CircleMarker>
      </>}
    </MapContainer>
  </div>;
}
