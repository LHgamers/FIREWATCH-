"use client";

/**
 * CoverageNotice
 * --------------
 * The map's "is this zero, or is it unknown?" answer.
 *
 * When a single day is pinned, this reads the engine's day ledger
 * (GET /api/day/{date}) for the current AOI *and filters* and prints the per
 * sensor state it returns:
 *
 *   observed                     → detections recorded
 *   observed_zero                → product delivered, nothing recorded here
 *   partial                      → only some platforms delivered
 *   unknown                      → no delivery evidence
 *   product_unavailable          → the source failed for that day
 *
 * The distinction is not cosmetic. "No detections" in this app is only ever
 * reported as a conditional zero with the delivery evidence next to it,
 * because a day nobody looked at is not a quiet day.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Clock } from "lucide-react";

import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/format";
import { LoadingIndicator } from "@/components/motion";
import type { DayDetail, SensorDayState } from "@/lib/types";

type Tone = "ok" | "warn" | "muted" | "cyan";

const STATE_META: Record<string, { tone: Tone; icon: typeof CheckCircle2; label: string }> = {
  observed: { tone: "ok", icon: CheckCircle2, label: "detections recorded" },
  observed_zero: { tone: "warn", icon: AlertTriangle, label: "product delivered, nothing recorded" },
  partial: { tone: "warn", icon: AlertTriangle, label: "partial delivery" },
  unknown: { tone: "muted", icon: CircleHelp, label: "no delivery evidence" },
  product_unavailable: { tone: "muted", icon: Clock, label: "source unavailable" },
};

function metaFor(state: string | undefined) {
  if (!state) return { tone: "muted" as Tone, icon: CircleHelp, label: "state not reported" };
  return STATE_META[state.toLowerCase()] ?? { tone: "muted" as Tone, icon: CircleHelp, label: state };
}

export function CoverageNotice({
  date,
  params,
  className,
}: {
  date: string | null;
  /** Engine query params for the AOI + filters (bbox/region, sensor, confidence, min_frp, daynight, satellites). */
  params: Record<string, string | number | boolean | undefined | null>;
  className?: string;
}) {
  const [data, setData] = useState<DayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(params);

  useEffect(() => {
    if (!date) {
      setData(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    apiGet<DayDetail>(`/api/day/${date}`, params)
      .then((payload) => {
        if (alive) setData(payload);
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e.message);
          setData(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, key]);

  if (!date) return null;

  if (loading && !data) {
    return (
      <div className={cn("flex items-center gap-2 px-1 py-1", className)}>
        <LoadingIndicator size="sm" label={`Reading the day ledger for ${date}`} />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border border-ember/30 bg-ember/[0.06] px-2.5 py-2",
          className,
        )}
      >
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-ember" />
        <p className="font-mono text-[9.5px] leading-relaxed text-muted">
          Coverage for {date} could not be loaded. It is unknown, not zero.
        </p>
      </div>
    );
  }
  if (!data) return null;

  const overall = metaFor(data.state);
  const OverallIcon = overall.icon;
  const sensors = Object.entries(data.sensors ?? {}) as [string, SensorDayState][];

  return (
    <div className={cn("rounded-md border border-line/70 bg-elevated/25 px-2.5 py-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <OverallIcon
            size={12}
            className={cn(
              overall.tone === "ok" ? "text-ok" : overall.tone === "warn" ? "text-ember" : "text-muted",
            )}
          />
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">coverage {date}</span>
          <Badge tone={overall.tone as "ok" | "warn" | "muted" | "cyan"}>{data.stateLabel || overall.label}</Badge>
        </div>
        <span className="truncate font-mono text-[9px] text-muted/70">{data.region}</span>
      </div>

      <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
        {sensors.map(([sensor, entry]) => {
          const m = metaFor(entry.state);
          return (
            <div
              key={sensor}
              className="flex items-baseline justify-between gap-2 border-b border-line/30 pb-0.5 last:border-0"
            >
              <span
                className={cn(
                  "font-mono text-[9.5px] uppercase tracking-[0.1em]",
                  sensor === "modis" ? "text-cyan/80" : "text-ember/80",
                )}
              >
                {sensor}
              </span>
              <span className="min-w-0 text-right font-mono text-[9.5px] text-muted">
                {m.label}
                {typeof entry.count === "number" ? (
                  <span className="text-ink/80"> · {entry.count.toLocaleString("en-US")}</span>
                ) : null}
                {entry.evidence ? (
                  <span className="block truncate text-[9px] text-muted/70">{entry.evidence}</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {data.method ? (
        <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-muted/70">{data.method}</p>
      ) : null}
    </div>
  );
}
