"use client";

import { Crosshair, Flame, Layers3, ListFilter, MoveRight, X } from "lucide-react";
import type { RegionDef } from "@/lib/regions";
import {
  Badge,
  ConfidenceBadge,
  KeyValue,
  Panel,
  PanelHead,
  SectionTitle,
  SensorChip,
} from "@/components/ui/primitives";
import { cn, formatInt, formatNum, sensorLabel } from "@/lib/format";
import { AskRail } from "./AskRail";
import type { EngagementPoint, RegionTotals, SelectedDetection } from "./types";

export interface HotspotItem {
  key: string;
  lat: number;
  lon: number;
  count: number | null;
  frp: number | null;
  sensor: "modis" | "viirs" | "both" | null;
}

export function AnalysisRail({
  region,
  selected,
  engagement,
  onCloseEngagement,
  onClearSelection,
  hotspots,
  hotspotsLabel,
  onFocus,
  mode,
  totals,
  loading,
  analyzeArmed,
  onArmAnalyze,
  className,
}: {
  region: RegionDef;
  selected: SelectedDetection | null;
  engagement: EngagementPoint | null;
  onCloseEngagement: () => void;
  onClearSelection: () => void;
  hotspots: HotspotItem[];
  hotspotsLabel: string;
  onFocus: (lat: number, lon: number) => void;
  mode: "cells" | "points";
  totals: RegionTotals | null;
  loading: boolean;
  analyzeArmed: boolean;
  onArmAnalyze: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {engagement ? (
        <AskRail
          lat={engagement.lat}
          lon={engagement.lon}
          obsId={engagement.obsId}
          onClose={onCloseEngagement}
        />
      ) : (
        <Panel>
          <PanelHead
            title="Target"
            hint="map click · right-click · or A"
            icon={<Crosshair size={14} />}
            action={analyzeArmed ? <Badge tone="cyan">armed</Badge> : null}
          />
          <div className="px-4 py-3.5">
            <p className="text-[12px] leading-relaxed text-muted">
              Point anywhere on the map to hand a coordinate to the evidence engine. Clicking a
              detection also passes its observation id.
            </p>
            <button type="button" onClick={onArmAnalyze} className={cn("btn mt-3 w-full", !analyzeArmed && "btn-primary")}>
              <Crosshair size={13} />
              {analyzeArmed ? "Click the map… (Esc to cancel)" : "Analyze this area"}
            </button>
            <div className="mt-3 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.08em] text-muted/60">
              <span>{region.name}</span>
              <span>{mode === "cells" ? "aggregated cells" : "clustered points"}</span>
            </div>
          </div>
        </Panel>
      )}

      {selected ? (
        <Panel>
          <PanelHead
            title="Selected detection"
            hint={selected.satellite}
            icon={<Flame size={14} />}
            action={
              <button
                type="button"
                onClick={onClearSelection}
                className="rounded-md p-1 text-muted hover:text-ink"
                aria-label="Clear selected detection"
              >
                <X size={13} />
              </button>
            }
          />
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="value text-[24px] leading-none">{formatNum(selected.frp, 1)}</span>
                <span className="font-mono text-[10px] text-muted">MW FRP</span>
              </div>
              <ConfidenceBadge value={selected.confidenceClass} />
            </div>
            <div className="mt-2 flex items-center gap-3">
              <SensorChip sensor={selected.sensor} />
              <span className="font-mono text-[10px] text-muted/70">{selected.instrument}</span>
            </div>
            <div className="mt-3">
              <KeyValue label="Acquired (UTC)" value={`${selected.acqDate} ${selected.acqTime}`} />
              <KeyValue label="Confidence (native)" value={`${selected.confidence}${selected.confidencePct !== null ? ` · ${Math.round(selected.confidencePct)}%` : ""}`} />
              <KeyValue label="Brightness" value={selected.brightness !== null ? `${formatNum(selected.brightness, 1)} K` : "—"} />
              <KeyValue label="Bright T31" value={selected.brightT31 !== null ? `${formatNum(selected.brightT31, 1)} K` : "—"} />
              <KeyValue
                label="Scan × track"
                value={selected.scan !== null && selected.track !== null ? `${formatNum(selected.scan, 2)} × ${formatNum(selected.track, 2)} km` : "—"}
              />
              <KeyValue label="Day / night" value={selected.daynight === "D" ? "Day" : selected.daynight === "N" ? "Night" : "—"} />
              <KeyValue label="Position" value={`${selected.lat.toFixed(3)}, ${selected.lon.toFixed(3)}`} />
              <KeyValue label="Dataset" value={sensorLabel(selected.sensor) + " " + selected.version} />
            </div>
            <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-muted/45">{selected.id}</p>
          </div>
        </Panel>
      ) : null}

      <Panel>
        <PanelHead
          title={hotspotsLabel}
          hint={mode === "cells" ? "largest cells in filter" : "highest FRP in view"}
          icon={<Layers3 size={14} />}
          action={<Badge tone="muted">{hotspots.length}</Badge>}
        />
        {hotspots.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[11.5px] text-muted">
            <ListFilter size={13} className="text-muted/60" />
            {loading ? "Loading hotspots…" : "Nothing to rank for the current filter."}
          </div>
        ) : (
          <ul className="fw-stagger divide-y divide-line/40">
            {hotspots.map((h) => (
              <li key={h.key}>
                <button
                  type="button"
                  onClick={() => onFocus(h.lat, h.lon)}
                  className="fw-row group flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-elevated/50"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-[11px] text-ink">
                      {h.lat.toFixed(2)}, {h.lon.toFixed(2)}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-muted/60">
                      {h.sensor ? (
                        <span className={cn("inline-block h-1 w-1 rounded-full", h.sensor === "modis" ? "bg-cyan" : h.sensor === "viirs" ? "bg-ember" : "bg-violet")} />
                      ) : null}
                      {h.sensor ? (h.sensor === "both" ? "both" : h.sensor) : "—"}
                      {h.frp !== null ? <span>max {formatNum(h.frp, 0)} MW</span> : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="value text-[12px] text-muted">{h.count !== null ? formatInt(h.count) : "—"}</span>
                    <MoveRight size={12} className="text-muted/40 transition-transform group-hover:translate-x-0.5 group-hover:text-cyan" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHead title="Filtered composition" hint="engine summary for this query" icon={<ListFilter size={14} />} />
        <div className="px-4 py-3">
          <KeyValue label="Detections" value={totals ? formatInt(totals.total) : "—"} />
          <KeyValue label="MODIS" value={totals ? formatInt(totals.modis) : "—"} />
          <KeyValue label="VIIRS" value={totals ? formatInt(totals.viirs) : "—"} />
          <KeyValue label="High confidence" value={totals ? formatInt(totals.high) : "—"} />
          <KeyValue label="Summed FRP" value={totals ? `${formatInt(totals.frpSum)} MW` : "—"} />
          <KeyValue
            label="Mean FRP / detection"
            value={totals && totals.total > 0 ? `${formatNum(totals.frpSum / totals.total, 1)} MW` : "—"}
          />
          <KeyValue label="Grid cells" value={totals ? formatInt(totals.cells) : "—"} />
        </div>
        <div className="border-t border-line/50 px-4 py-2">
          <p className="font-mono text-[9px] leading-relaxed text-muted/55">
            Totals are derived from the same filtered detections shown on the map.
          </p>
        </div>
      </Panel>

      {selected ? null : (
        <div className="px-1">
          <SectionTitle>Kernel</SectionTitle>
          <p className="text-[10.5px] leading-relaxed text-muted/60">
            Click a point or cluster to inspect it. Cluster sizes aggregate the detections currently
            in the source; individual points carry native MODIS / VIIRS attributes unchanged.
          </p>
        </div>
      )}
    </div>
  );
}
