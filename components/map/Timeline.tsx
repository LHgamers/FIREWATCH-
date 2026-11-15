"use client";

/**
 * Timeline
 * --------
 * A scrubber over the dates the engine actually stores — no invented calendar,
 * no interpolated days, no "expected" days. The tick list is `coverage.days`
 * from /api/meta; each bar height is the detection count that /api/timeseries
 * returned for the *current* AOI and filters, so the chart and the map can
 * never disagree.
 *
 * Modes:
 *   day     → start = end = the selected date (one day of detections)
 *   window  → the full stored window (start/end cleared)
 *
 * Playback steps through real dates with a real interval. It is a view
 * control, not a progress indicator: it never advances past the last stored
 * day, it stops when the tab is hidden, and it is disabled under
 * prefers-reduced-motion (motion is not decoration the user can opt out of
 * halfway).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { CalendarRange, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";

import { cn, formatCompact, formatInt } from "@/lib/format";
import { Badge } from "@/components/ui/primitives";
import { LoadingIndicator } from "@/components/motion";
import { usePrefersReducedMotion } from "@/lib/motion";
import type { TimeseriesPoint } from "@/lib/types";

export type TimelineMode = "day" | "window";

export function Timeline({
  days,
  series,
  loading,
  error,
  mode,
  activeDay,
  onModeChange,
  onDayChange,
  onPlayStateChange,
  playing,
  className,
}: {
  days: string[];
  series: TimeseriesPoint[] | null;
  loading: boolean;
  error: string | null;
  mode: TimelineMode;
  activeDay: string | null;
  onModeChange: (mode: TimelineMode) => void;
  onDayChange: (day: string) => void;
  onPlayStateChange: (playing: boolean) => void;
  playing: boolean;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const timerRef = useRef<number | null>(null);

  const byDate = useMemo(() => {
    const map = new Map<string, TimeseriesPoint>();
    (series ?? []).forEach((p) => map.set(p.date, p));
    return map;
  }, [series]);

  const max = useMemo(() => {
    let peak = 0;
    for (const p of series ?? []) if (p.total != null && p.total > peak) peak = p.total;
    return peak;
  }, [series]);

  const index = activeDay ? Math.max(0, days.indexOf(activeDay)) : 0;

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    onPlayStateChange(false);
  }, [onPlayStateChange]);

  const step = useCallback(
    (delta: number) => {
      if (days.length === 0) return;
      const next = Math.min(days.length - 1, Math.max(0, index + delta));
      onDayChange(days[next]);
    },
    [days, index, onDayChange],
  );

  /* Playback: real days, real interval, stops at the last stored day. */
  useEffect(() => {
    if (!playing || reduced) {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = window.setInterval(() => {
      if (document.hidden) return;
      onDayChange(days[Math.min(days.length - 1, Math.max(0, days.indexOf(activeDay ?? days[0]) + 1))]);
    }, 1100);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [playing, reduced, days, activeDay, onDayChange]);

  /* Hitting the last day ends playback — never a silent wrap-around. */
  useEffect(() => {
    if (playing && activeDay && days.length > 0 && activeDay === days[days.length - 1]) stop();
  }, [playing, activeDay, days, stop]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && playing) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [playing, stop]);

  if (days.length === 0) {
    return (
      <div className={cn("panel px-3.5 py-3", className)}>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted/70">Timeline</p>
        <p className="mt-1 text-[11.5px] text-muted">
          No observation dates are available for this window, so the timeline is empty.
        </p>
      </div>
    );
  }

  const active = activeDay ?? days[days.length - 1];
  const activePoint = byDate.get(active) ?? null;

  return (
    <div className={cn("panel px-3 py-2.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarRange size={13} className="text-cyan" />
          <p className="kicker text-[9px]">Timeline</p>
          <Badge tone="muted">{days.length} stored days</Badge>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="inline-flex rounded-md border border-line bg-elevated/40 p-0.5">
            {(
              [
                { value: "day", label: "Single day" },
                { value: "window", label: "Full window" },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => onModeChange(o.value)}
                aria-pressed={mode === o.value}
                className={cn(
                  "fw-tap rounded px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em]",
                  mode === o.value ? "bg-cyan/15 text-cyan" : "text-muted/70 hover:text-ink",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={index <= 0}
              className="fw-tap grid h-6 w-6 place-items-center rounded border border-line bg-elevated/50 text-muted hover:border-cyan/40 hover:text-ink disabled:opacity-35"
              aria-label="Previous stored day"
            >
              <ChevronLeft size={11} />
            </button>
            <button
              type="button"
              onClick={() => (playing ? stop() : onPlayStateChange(true))}
              disabled={reduced || days.length < 2}
              title={reduced ? "Playback disabled: reduced motion is on" : "Step through the stored days"}
              className="fw-tap grid h-6 w-6 place-items-center rounded border border-line bg-elevated/50 text-muted hover:border-cyan/40 hover:text-ink disabled:opacity-35"
              aria-label={playing ? "Pause timeline playback" : "Play timeline"}
            >
              {playing ? <Pause size={11} /> : <Play size={11} />}
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={index >= days.length - 1}
              className="fw-tap grid h-6 w-6 place-items-center rounded border border-line bg-elevated/50 text-muted hover:border-cyan/40 hover:text-ink disabled:opacity-35"
              aria-label="Next stored day"
            >
              <ChevronRight size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* Bars: one per stored day, height = detections for the current query. */}
      <div className="mt-2 flex items-end gap-[3px]" aria-hidden>
        {days.map((day) => {
          const point = byDate.get(day);
          const total = point?.total ?? 0;
          const height = max > 0 ? Math.max(2, Math.round((total / max) * 26)) : 2;
          const isActive = day === active;
          return (
            <button
              key={day}
              type="button"
              tabIndex={-1}
              onClick={() => onDayChange(day)}
              className={cn(
                "fw-grow-y fw-tap group relative flex-1 rounded-sm",
                isActive ? "bg-cyan/80" : total > 0 ? "bg-cyan/25 hover:bg-cyan/45" : "bg-line/60 hover:bg-line",
              )}
              style={{ height, "--fw-delay": `${Math.min(days.indexOf(day) * 40, 320)}ms` } as React.CSSProperties}
              title={`${day} · ${point ? `${formatInt(total)} detections` : "no series point returned"}`}
            />
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label className="flex min-w-[190px] flex-1 items-center gap-2">
          <span className="sr-only">Selected day</span>
          <input
            type="range"
            min={0}
            max={days.length - 1}
            step={1}
            value={index}
            onChange={(e) => onDayChange(days[Number(e.target.value)])}
            disabled={mode === "window"}
            className="w-full accent-cyan disabled:opacity-40"
            aria-label="Stored day"
          />
        </label>
        <div className="flex items-center gap-2 font-mono text-[9.5px] text-muted">
          {loading ? <LoadingIndicator size="sm" label="" variant="spinner" /> : null}
          <span className={cn("tabular-nums", mode === "window" && "opacity-50")}>{active}</span>
          <span className="text-line">·</span>
          <span className="tabular-nums text-ink/80">
            {error ? "—" : activePoint ? `${formatCompact(activePoint.total)} det` : "no point"}
          </span>
          {activePoint ? (
            <>
              <span className="text-line">/</span>
              <span className="text-cyan/80">M {formatCompact(activePoint.modis)}</span>
              <span className="text-ember/80">V {formatCompact(activePoint.viirs)}</span>
            </>
          ) : null}
        </div>
      </div>

      <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-muted/70">
        Bars show detection counts for the current area and filters. Days outside {days[0]} →{" "}
        {days[days.length - 1]} are not drawn because they are unknown, not zero.
        {error ? " The activity series is temporarily unavailable." : ""}
      </p>
    </div>
  );
}
