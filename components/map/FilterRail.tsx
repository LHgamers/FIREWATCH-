"use client";

import { RotateCcw, SlidersHorizontal, X } from "lucide-react";
import type { RegionDef } from "@/lib/regions";
import { cn } from "@/lib/format";
import { Badge, Panel, PanelHead, SectionTitle, Segmented } from "@/components/ui/primitives";
import type { BasemapMode } from "@/lib/map-style";
import { BASEMAPS } from "@/lib/map-style";
import { CONFIDENCE_OPTIONS, SATELLITE_OPTIONS } from "./types";
import type { MapFilterState } from "./types";
import type { Bbox } from "./aoi";
import { bboxLabel } from "./aoi";

const SENSOR_OPTIONS: { value: MapFilterState["sensor"]; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "modis", label: "MODIS" },
  { value: "viirs", label: "VIIRS" },
];

const DAYNIGHT_OPTIONS: { value: MapFilterState["daynight"]; label: string }[] = [
  { value: "", label: "Any" },
  { value: "D", label: "Day" },
  { value: "N", label: "Night" },
];

const CONF_STYLE: Record<string, string> = {
  high: "border-ok/45 bg-ok/12 text-ok",
  nominal: "border-ember/45 bg-ember/12 text-ember",
  low: "border-line bg-elevated/70 text-muted",
};

export function FilterRail({
  region,
  filters,
  onChange,
  onReset,
  days,
  activeCount,
  basemap,
  onBasemapChange,
  imageryDate,
  onImageryDateChange,
  filteredTotal,
  loading,
  aoi,
  onClearAoi,
  className,
  onClose,
}: {
  region: RegionDef;
  filters: MapFilterState;
  onChange: (patch: Partial<MapFilterState>) => void;
  onReset: () => void;
  days: string[];
  activeCount: number;
  basemap: BasemapMode;
  onBasemapChange: (mode: BasemapMode) => void;
  imageryDate: string;
  onImageryDateChange: (date: string) => void;
  filteredTotal: number | null;
  loading: boolean;
  aoi?: Bbox | null;
  onClearAoi?: () => void;
  className?: string;
  onClose?: () => void;
}) {
  const toggleConfidence = (value: MapFilterState["confidence"][number]) => {
    const next = filters.confidence.includes(value)
      ? filters.confidence.filter((c) => c !== value)
      : [...filters.confidence, value];
    onChange({ confidence: next });
  };

  const toggleSatellite = (value: string) => {
    const next = filters.satellites.includes(value)
      ? filters.satellites.filter((s) => s !== value)
      : [...filters.satellites, value];
    onChange({ satellites: next });
  };

  return (
    <Panel className={cn("flex max-h-[calc(100vh-120px)] flex-col", className)}>
      <PanelHead
        title="Query"
        hint="Sensor · FRP · time"
        icon={<SlidersHorizontal size={14} />}
        action={
          <div className="flex items-center gap-1.5">
            {activeCount > 0 ? <Badge tone="cyan">{activeCount} active</Badge> : <Badge tone="muted">all</Badge>}
            {onClose ? (
              <button
                type="button"
                className="btn-ghost rounded-md p-1 text-muted lg:hidden"
                onClick={onClose}
                aria-label="Close filters"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        }
      />

      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        <section>
          <SectionTitle>Study region</SectionTitle>
          <p className="text-[12.5px] font-medium text-ink">{region.name}</p>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
            {region.bbox.map((v) => v.toFixed(1)).join(" / ")}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted/80">{region.note}</p>
        </section>

        <section>
          <SectionTitle>Query extent</SectionTitle>
          {aoi ? (
            <div className="rounded-md border border-cyan/30 bg-cyan/[0.06] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-cyan">area of interest</span>
                {onClearAoi ? (
                  <button
                    type="button"
                    onClick={onClearAoi}
                    className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink"
                  >
                    clear
                  </button>
                ) : null}
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-ink/85">{bboxLabel(aoi)}</p>
            </div>
          ) : (
            <p className="font-mono text-[10px] leading-relaxed text-muted/80">
              Whole study region. Draw a rectangle on the map (Shift + A) to restrict every query to it.
            </p>
          )}
        </section>

        <div className="h-px bg-line/50" />

        <section>
          <SectionTitle>Sensor</SectionTitle>
          <Segmented
            options={SENSOR_OPTIONS}
            value={filters.sensor}
            onChange={(sensor) => onChange({ sensor })}
            size="sm"
            className="w-full justify-between"
          />
        </section>

        <section>
          <SectionTitle>Confidence class</SectionTitle>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Confidence class filter">
            {CONFIDENCE_OPTIONS.map((opt) => {
              const active = filters.confidence.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleConfidence(opt.value)}
                  className={cn(
                    "fw-tap rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em]",
                    active ? CONF_STYLE[opt.value] : "border-line/70 bg-transparent text-muted/60 hover:text-muted",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <SectionTitle right={<span className="value text-[11px]">{filters.minFrp > 0 ? `${filters.minFrp} MW` : "off"}</span>}>
            Min FRP
          </SectionTitle>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={filters.minFrp}
            onChange={(e) => onChange({ minFrp: Number(e.target.value) })}
            className="w-full accent-cyan"
            aria-label="Minimum fire radiative power in megawatts"
          />
          <div className="mt-1 flex justify-between font-mono text-[9px] text-muted/60">
            <span>0</span>
            <span>100</span>
            <span>200 MW</span>
          </div>
        </section>

        <section>
          <SectionTitle>Day / night</SectionTitle>
          <Segmented
            options={DAYNIGHT_OPTIONS}
            value={filters.daynight}
            onChange={(daynight) => onChange({ daynight })}
            size="sm"
            className="w-full justify-between"
          />
        </section>

        <section>
          <SectionTitle>Satellite platform</SectionTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {SATELLITE_OPTIONS.map((sat) => {
              const active = filters.satellites.includes(sat.value);
              return (
                <button
                  key={sat.value}
                  type="button"
                  aria-pressed={active}
                  aria-label={sat.label}
                  title={sat.label}
                  onClick={() => toggleSatellite(sat.value)}
                  className={cn(
                    "fw-tap flex items-center justify-between gap-1 rounded-md border px-2 py-1 font-mono text-[10px]",
                    active
                      ? "border-cyan/40 bg-cyan/10 text-cyan"
                      : "border-line/70 text-muted/70 hover:border-line hover:text-muted",
                  )}
                >
                  <span className="truncate">{sat.value}</span>
                  <span className="text-[8px] uppercase tracking-[0.08em] opacity-60">{sat.sensor}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="h-px bg-line/50" />

        <section>
          <SectionTitle>Basemap</SectionTitle>
          <div className="space-y-1">
            {BASEMAPS.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onBasemapChange(b.id)}
                aria-pressed={basemap === b.id}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                  basemap === b.id
                    ? "border-cyan/40 bg-cyan/10 text-ink"
                    : "border-transparent text-muted hover:border-line/70 hover:bg-elevated/40",
                )}
              >
                <span className="text-[11.5px]">{b.label}</span>
                <span className={cn("font-mono text-[9px] uppercase tracking-[0.1em]", basemap === b.id ? "text-cyan" : "text-muted/50")}>
                  {b.short}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted/70">
            {BASEMAPS.find((item) => item.id === basemap)?.note}
          </p>
          <label className="mt-2 block">
            <span className="kicker text-[9px]">NASA composite date</span>
            <select
              value={imageryDate}
              onChange={(e) => onImageryDateChange(e.target.value)}
              disabled={(basemap !== "viirs" && basemap !== "modis") || days.length === 0}
              className="mt-1 w-full rounded-md border border-line bg-elevated/50 px-1.5 py-1 font-mono text-[10.5px] text-ink outline-none focus:border-cyan/50 disabled:opacity-40"
              aria-label="Imagery date"
            >
              {(days.length ? days : [imageryDate]).map((d) => (
                <option key={d} value={d} className="bg-surface">
                  {d}
                </option>
              ))}
            </select>
          </label>
        </section>

        <button type="button" onClick={onReset} className="btn btn-ghost w-full" disabled={activeCount === 0}>
          <RotateCcw size={13} />
          Reset filters
        </button>

        <div className="border-t border-line/50 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="kicker text-[9px]">matching</span>
            <span className={cn("value text-[12px]", loading && "opacity-50")}>
              {filteredTotal === null ? "—" : filteredTotal.toLocaleString("en-US")}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="kicker text-[9px]">cell</span>
            <span className="font-mono text-[10px] text-muted">{basemap === "clean" ? "no imagery" : imageryDate}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
