"use client";

import { Flame, Radio, Satellite, ShieldCheck, Sparkles } from "lucide-react";
import type { RegionDef } from "@/lib/regions";
import type { RegionTotals } from "./types";
import { cn, formatCompact, formatDateTime, formatInt, formatNum } from "@/lib/format";
import { Badge } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/motion";

function Metric({
  label,
  value,
  numeric,
  format,
  unit,
  tone,
  loading,
}: {
  label: string;
  /** Rendered when no numeric value is available (loading, unknown, null). */
  value: string;
  /** When present the figure counts to its new value instead of snapping. */
  numeric?: number | null;
  format?: (n: number) => string;
  unit?: string;
  tone?: "cyan" | "ember" | "ok" | "fire";
  loading?: boolean;
}) {
  const toneClass =
    tone === "cyan" ? "text-cyan" : tone === "ember" ? "text-ember" : tone === "ok" ? "text-ok" : tone === "fire" ? "text-ember-fire" : "text-ink";
  return (
    <div className="min-w-[86px] px-3 py-2.5">
      <p className="kicker text-[9px]">{label}</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            "value text-[16px] font-medium leading-none transition-opacity",
            toneClass,
            loading && "opacity-60",
          )}
        >
          {numeric != null && !loading ? (
            <AnimatedNumber value={numeric} format={format ?? formatInt} fallback={value} />
          ) : (
            value
          )}
        </span>
        {unit ? <span className="font-mono text-[9px] text-muted/70">{unit}</span> : null}
      </div>
    </div>
  );
}

export function StatsStrip({
  region,
  totals,
  loading,
  activeCount,
  windowStart,
  windowEnd,
  windowDays,
  freshness,
  mode,
  visibleCount,
  engineTotal,
  aoiBbox,
}: {
  region: RegionDef;
  totals: RegionTotals | null;
  loading: boolean;
  activeCount: number;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  freshness: string | null;
  mode: "cells" | "points";
  visibleCount: number | null;
  engineTotal: number | null;
  /** When a rectangle is active the figures above describe the AOI, not the region. */
  aoiBbox?: [number, number, number, number] | null;
}) {
  const modis = totals?.modis ?? null;
  const viirs = totals?.viirs ?? null;
  const high = totals?.high ?? null;
  const maxFrp = totals?.maxFrp ?? null;
  const firstLoad = loading && totals === null;

  return (
    <div className="panel flex flex-col overflow-hidden lg:flex-row lg:items-stretch">
      <div className="flex items-start justify-between gap-3 border-b border-line/60 px-4 py-3 lg:w-[268px] lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Radio size={11} className="text-cyan" />
            <p className="kicker text-[9px]">Active study area</p>
          </div>
          <p className="mt-1 truncate text-[13px] font-semibold text-ink">
            {region.name}
            {aoiBbox ? <span className="ml-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-cyan">· AOI</span> : null}
          </p>
          <p className="mt-0.5 font-mono text-[9.5px] text-muted">
            {aoiBbox
              ? `${aoiBbox[0].toFixed(2)}, ${aoiBbox[1].toFixed(2)}, ${aoiBbox[2].toFixed(2)}, ${aoiBbox[3].toFixed(2)}`
              : region.bbox.map((v) => v.toFixed(1)).join(" / ")}
          </p>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-muted/60">
            {windowStart || "—"} → {windowEnd || "—"}
            {aoiBbox ? " · figures are AOI totals" : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone="ok">
            <span className="h-1 w-1 rounded-full bg-ok" />
            NASA FIRMS
          </Badge>
          <span
            className="font-mono text-[9px] text-muted/60"
            title={freshness ? `Last successful data update: ${freshness}` : "Last successful data update not reported"}
          >
            update {freshness ? formatDateTime(freshness) : "not reported"}
          </span>
        </div>
      </div>

      <div className="fw-stagger scroll-thin flex flex-1 divide-x divide-line/50 overflow-x-auto">
        <Metric
          label="Detections"
          value={firstLoad ? "···" : formatInt(totals?.total ?? null)}
          numeric={totals?.total}
          loading={loading}
          tone="cyan"
        />
        <Metric label="MODIS" value={firstLoad ? "···" : formatInt(modis)} numeric={modis} tone="cyan" loading={loading} />
        <Metric label="VIIRS" value={firstLoad ? "···" : formatInt(viirs)} numeric={viirs} tone="ember" loading={loading} />
        <Metric label="High conf." value={firstLoad ? "···" : formatInt(high)} numeric={high} tone="ok" loading={loading} />
        <Metric
          label="Max FRP"
          value={firstLoad ? "···" : formatNum(maxFrp, maxFrp !== null && maxFrp >= 100 ? 0 : 1)}
          numeric={maxFrp}
          format={(n) => formatNum(n, n >= 100 ? 0 : 1)}
          unit="MW"
          tone="fire"
          loading={loading}
        />
        <Metric
          label={mode === "cells" ? "Cells in view" : "Points in view"}
          value={firstLoad ? "···" : formatInt(visibleCount)}
          numeric={visibleCount}
          loading={loading}
        />
        <Metric
          label="Engine total"
          value={engineTotal === null ? "—" : formatInt(engineTotal)}
          numeric={engineTotal}
          unit="obs"
          loading={loading}
        />
      </div>

      <div className="hidden shrink-0 flex-col justify-center gap-1 border-l border-line/60 px-4 py-3 xl:flex">
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted">
          <Sparkles size={11} className="text-cyan" />
          {activeCount === 0 ? "No local filter override" : `${activeCount} local filter${activeCount > 1 ? "s" : ""} active`}
        </div>
        <div className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.08em] text-muted/60">
          <span className="inline-flex items-center gap-1">
            <Satellite size={9} /> MODIS C6.1
          </span>
          <span className="inline-flex items-center gap-1">
            <Flame size={9} /> VIIRS 375 m
          </span>
          <span className="inline-flex items-center gap-1">
            <ShieldCheck size={9} /> {windowDays} d window
          </span>
        </div>
      </div>
    </div>
  );
}
