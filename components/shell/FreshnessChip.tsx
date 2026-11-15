"use client";

/**
 * FreshnessChip — the global "how current is this?" indicator.
 *
 * It shows three different things and never conflates them:
 *   · the **observation window** (acquisition dates from NASA),
 *   · the **last successful source check** (our scheduler), and
 *   · a **stale warning** when the check has not succeeded recently.
 *
 * Data comes from GET /api/freshness, refreshed every five minutes and on tab
 * focus. If the endpoint is missing (older engine), the chip falls back to the
 * `/api/meta` coverage block and says "check status unavailable" rather than
 * implying a check ran.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { apiGet } from "@/lib/api";
import { relativeAge } from "@/lib/format";
import type { Freshness } from "@/lib/types";
import { cn } from "@/lib/format";

const POLL_MS = 5 * 60 * 1000;

export function FreshnessChip({ fallbackLast }: { fallbackLast?: string | null }) {
  const [data, setData] = useState<Freshness | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiGet<Freshness>("/api/freshness", {}, { signal });
      setData(next);
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const last = data?.observationWindow.last ?? fallbackLast ?? null;
  const stale = data?.state === "stale";
  const never = data?.state === "never-checked";

  const title = data
    ? [
        `Observation window: ${data.observationWindow.first ?? "—"} → ${data.observationWindow.last ?? "—"} (${data.observationWindow.days} days)`,
        `Last successful source check: ${data.lastSuccessAt ?? "not yet in this process"}`,
        data.lastCheckAt ? `Last check attempt: ${data.lastCheckAt}` : "No check has run in this process",
        `Scheduler: ${data.scheduler.enabled ? `every ${Math.round(data.scheduler.intervalSeconds / 60)} min` : "disabled"}`,
        data.lastError ? `Last error: ${data.lastError}` : "",
        "An hourly check does not mean NASA publishes new observations hourly.",
      ]
        .filter(Boolean)
        .join("\n")
    : "Data-freshness endpoint not available on this engine build.";

  return (
    <div
      className={cn(
        "hidden items-center gap-1.5 rounded-lg border px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] xl:flex",
        stale || failed
          ? "border-ember/30 bg-ember/5 text-ember"
          : "border-line bg-elevated/50 text-muted",
      )}
      title={title}
      aria-label={title}
    >
      {stale || failed ? (
        <AlertTriangle size={11} />
      ) : data?.running ? (
        <RefreshCw size={11} className="animate-spin" />
      ) : (
        <Clock size={11} />
      )}
      <span>
        data {last ?? "—"}
        {data && !failed ? ` · ${data.state === "fresh" ? relativeAge(data.lastSuccessAt) : data.state}` : ""}
        {failed ? " · freshness unavailable" : ""}
        {never && !failed ? " · no check yet" : ""}
      </span>
    </div>
  );
}
