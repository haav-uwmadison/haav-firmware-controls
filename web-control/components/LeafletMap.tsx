"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import type { BoatPosition, TrailPoint } from "./GpsMap";

type Props = { position: BoatPosition | null; trail: TrailPoint[]; follow: boolean };

const DEFAULT_CENTER: [number, number] = [41.5, -81.7]; // placeholder until the first fix arrives
const HEADING_LINE_M = 12;

/** Keeps the view on the boat while "Follow" is on; zooms in once on the first fix. */
function FollowBoat({ position, follow }: { position: BoatPosition | null; follow: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!position || !follow) return;
    const zoom = map.getZoom() < 15 ? 17 : map.getZoom();
    map.setView([position.lat, position.lon], zoom, { animate: true });
  }, [map, position, follow]);
  return null;
}

/** Invalidates Leaflet's size when the panel is resized, otherwise tiles stay blank after layout changes. */
function ResizeAware() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function headingEnd(position: BoatPosition): [number, number] | null {
  if (position.heading === null) return null;
  const rad = (position.heading * Math.PI) / 180;
  const dLat = (HEADING_LINE_M * Math.cos(rad)) / 111_320;
  const dLon = (HEADING_LINE_M * Math.sin(rad)) / (111_320 * Math.cos((position.lat * Math.PI) / 180));
  return [position.lat + dLat, position.lon + dLon];
}

export function LeafletMap({ position, trail, follow }: Props) {
  const center = position ? [position.lat, position.lon] as [number, number] : DEFAULT_CENTER;
  const end = position ? headingEnd(position) : null;
  return <MapContainer center={center} zoom={position ? 17 : 3} zoomControl className="h-full w-full bg-[#0b0b0d]" attributionControl>
    {/* OpenStreetMap tiles need no key; globals.css darkens them with a CSS filter to match the dashboard. */}
    <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' maxZoom={19} className="map-tiles-dark" />
    <ResizeAware />
    <FollowBoat position={position} follow={follow} />
    {trail.length > 1 && <Polyline positions={trail} pathOptions={{ color: "#7dd3fc", weight: 2, opacity: 0.8 }} />}
    {trail.length > 0 && <CircleMarker center={trail[0]} radius={4} pathOptions={{ color: "#a1a1aa", fillColor: "#a1a1aa", fillOpacity: 1, weight: 1 }} />}
    {position && end && <Polyline positions={[[position.lat, position.lon], end]} pathOptions={{ color: "#86efac", weight: 3, opacity: 1 }} />}
    {position && <CircleMarker center={[position.lat, position.lon]} radius={7} pathOptions={{ color: "#09090b", fillColor: "#86efac", fillOpacity: 1, weight: 2 }} />}
  </MapContainer>;
}
