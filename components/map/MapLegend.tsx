"use client";

import { cn } from "@/lib/format";
import { MAP_COLORS } from "@/lib/map-style";

export function MapLegend({
  mode,
  freshDate,
  className,
}: {
  mode: "cells" | "points";
  freshDate: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none w-[186px] rounded-lg border border-line/70 bg-panel/85 p-2.5 shadow-panel backdrop-blur-md",
        className,
      )}
      aria-label="Map legend"
    >
      <p className="kicker text-[9px]">Legend</p>

      <div className="mt-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: MAP_COLORS.fire }} />
          <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">thermal anomaly</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full border border-[#FF9D42]" />
          <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">MODIS outline</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full border border-[#FFD84D]" />
          <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">VIIRS outline</span>
        </div>
      </div>

      <div className="my-2 h-px bg-line/60" />

      <div className="flex items-end justify-between gap-2">
        <div className="flex items-end gap-1.5">
          {[7, 11, 16].map((size, i) => (
            <span
              key={size}
              className="rounded-full border border-[#FF633D]/70 bg-[#FF633D]/25"
              style={{ width: size, height: size, opacity: 0.45 + i * 0.2 }}
            />
          ))}
        </div>
        <div className="text-right">
          <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">{mode === "cells" ? "count" : "FRP"}</p>
          <p className="font-mono text-[9px] text-muted/60">{mode === "cells" ? "low → high" : "MW · native value"}</p>
        </div>
      </div>

      {mode === "points" ? (
        <>
          <div className="my-2 h-px bg-line/60" />
          <div className="flex items-center gap-2">
            <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden className="shrink-0">
              <circle cx="12" cy="8" r="7" fill="rgba(255,157,66,0.10)" stroke="#FF9D42" strokeWidth="0.8" />
              <circle cx="12" cy="8" r="4.4" fill="rgba(16,24,39,0.9)" stroke="#FF9D42" strokeWidth="1" />
              <circle cx="12" cy="8" r="1.5" fill="#FFD9B0" />
            </svg>
            <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">cluster · count · click to zoom</span>
          </div>
        </>
      ) : null}

      <div className="my-2 h-px bg-line/60" />

      <div className="flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ok/50" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
        </span>
        <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted/80">
          NASA FIRMS · observed through {freshDate ?? "—"}
        </p>
      </div>
      <p className="mt-1.5 font-mono text-[8px] leading-relaxed text-muted/55">
        Thermal anomaly detections are not confirmed fires or perimeters. Outline color identifies sensor only.
      </p>
    </div>
  );
}
