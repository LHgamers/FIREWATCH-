"use client";

import dynamic from "next/dynamic";
import { Panel } from "@/components/ui/primitives";

interface AskPanelProps {
  lat: number;
  lon: number;
  obsId?: string | null;
  onClose?: () => void;
}

function AskSkeleton() {
  return (
    <div className="space-y-2 px-4 py-4">
      <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-cyan/70">Loading evidence rail</p>
      <div className="loading-sweep relative h-2 overflow-hidden rounded bg-elevated/60" />
      <div className="loading-sweep relative h-2 w-5/6 overflow-hidden rounded bg-elevated/50" />
      <div className="loading-sweep relative h-2 w-2/3 overflow-hidden rounded bg-elevated/40" />
    </div>
  );
}

/**
 * Boundary around the Ask-the-Earth rail (owned by the intelligence agent).
 * Loaded client-only so the map page keeps rendering and stays interactive
 * while the panel's own POST /api/ask-the-earth request is in flight.
 */
const AskEarthPanel = dynamic<AskPanelProps>(
  () => import("@/components/ask/AskEarthPanel").then((mod) => mod.AskEarthPanel),
  { ssr: false, loading: () => <AskSkeleton /> },
);

export function AskRail({ lat, lon, obsId, onClose }: { lat: number; lon: number; obsId: string | null; onClose: () => void }) {
  return (
    <Panel className="overflow-hidden">
      <AskEarthPanel lat={lat} lon={lon} obsId={obsId} onClose={onClose} />
    </Panel>
  );
}
