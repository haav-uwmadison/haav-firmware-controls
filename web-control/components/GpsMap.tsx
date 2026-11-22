"use client";

import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { toneBadge } from "@/components/StatusBar";
import { cn } from "@/lib/utils";

export type BoatPosition = { lat: number; lon: number; /** degrees, 0..360, null when unknown */ heading: number | null; fixType: number; satellites: number; time: number };
export type TrailPoint = [number, number];

type Props = {
  position: BoatPosition | null;
  trail: TrailPoint[];
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  onClearTrail: () => void;
  className?: string;
};

// Leaflet touches `window` at import time, so the map itself is loaded client-side only.
const LeafletMap = dynamic(() => import("./LeafletMap").then(m => m.LeafletMap), { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading map…</div> });

const fixNames: Record<number, string> = { 0: "No GPS", 1: "No fix", 2: "2D fix", 3: "3D fix", 4: "DGPS", 5: "RTK float", 6: "RTK fixed" };

/** GPS map panel: boat position, heading and trail on dark tiles. */
export function GpsMapPanel({ position, trail, follow, onFollowChange, onClearTrail, className }: Props) {
  const hasFix = !!position && position.fixType >= 2;
  const badge = !position ? { tone: "idle" as const, text: "No GPS data" } : hasFix ? { tone: "ok" as const, text: `${fixNames[position.fixType] ?? `Fix ${position.fixType}`} · ${position.satellites} sats` } : { tone: "warn" as const, text: `${fixNames[position.fixType] ?? "No fix"} · ${position.satellites} sats` };
  return <Card className={cn("flex min-h-0 flex-col gap-0 py-0", className)}>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">GPS</CardTitle>
      <div className="flex items-center gap-2">
        {position && <span className="tabular hidden font-mono text-[11px] text-muted-foreground xl:inline">{position.lat.toFixed(6)}, {position.lon.toFixed(6)}{position.heading !== null && ` · ${Math.round(position.heading)}°`}</span>}
        <Badge className={cn("text-[11px] font-bold tracking-[0.04em]", toneBadge[badge.tone])} role="status">{badge.text}</Badge>
        <Toggle size="sm" pressed={follow} onPressedChange={onFollowChange} className="h-6 px-2 text-[11px]" aria-label="Keep the map centred on the boat">Follow</Toggle>
        <button type="button" onClick={onClearTrail} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" disabled={trail.length === 0}>Clear trail</button>
      </div>
    </CardHeader>
    <CardContent className="relative min-h-0 flex-1 p-0">
      <div className="h-full overflow-hidden rounded-b-xl">
        <LeafletMap position={hasFix ? position : null} trail={trail} follow={follow} />
      </div>
      {!hasFix && <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-background/60 text-sm text-muted-foreground">{position ? "Waiting for a GPS fix" : "No position yet. Connect to the Pixhawk."}</div>}
    </CardContent>
  </Card>;
}
