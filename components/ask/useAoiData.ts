"use client";

/**
 * One AOI, one serialised query chain.
 *
 * The engine is fast for a wide bbox and slow for a cold, narrow one: measured
 * on this machine, five concurrent AOI queries took 15–21 s each and one of them
 * returned HTTP 500, while the same five run one-at-a-time answer in 1–8 s. So
 * this hook never fires a burst: it walks coverage → summary → calendar →
 * observations → grounded answer, stops on the first failure, and reports the
 * *actual* query in flight (no invented progress bar).
 *
 * Latest-wins: a new selection invalidates the previous chain, so a fast click
 * sequence can never paint numbers from an older AOI next to a newer bbox.
 * `coverage` is window-global, not AOI-scoped, so it is cached for the session.
 *
 * `/api/calendar?bbox=` is the least reliable call on this engine: measured here,
 * it answers in 2–7 s for a small AOI, 24.6 s for a hemisphere-sized one, and it
 * intermittently returns 500 or times out while the engine is under load (5 of 10
 * sequential attempts failed). So each step gets one retry after a short backoff,
 * and a calendar failure is *not* fatal: the panel keeps the real summary numbers
 * and the verdict falls back to COVERAGE UNKNOWN, because a day-level state we
 * could not read is not a zero.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AskResponse, CalendarResponse, Coverage, DetectionCollection, Summary } from "@/lib/types";

/**
 * One retry, 600 ms apart, for a call the engine occasionally drops under load.
 * The retry never invents data: a second failure is still a failure.
 */
async function withRetry<T>(fn: () => Promise<T>, stale: boolean): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (stale) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return await fn();
  }
}

export interface CoveragePayload {
  coverage: Coverage;
  windows: unknown[];
  states: Record<string, { code: string; label: string; meaning: string }>;
  method: string;
}

export interface AoiData {
  coverage: CoveragePayload | null;
  summary: Summary | null;
  calendar: CalendarResponse | null;
  /** Set when /api/calendar could not be read, even after a retry. */
  calendarError: string | null;
  observations: DetectionCollection | null;
  ask: AskResponse | null;
  /** The query currently in flight, for an honest status line. */
  step: string | null;
  error: string | null;
  hours: number;
  setHours: (h: number) => void;
  reload: () => void;
}

let coverageCache: CoveragePayload | null = null;

export function useAoiData(args: {
  bbox: string;
  lat: number;
  lon: number;
  radiusKm: number;
  hours: number;
}): AoiData {
  const { bbox, lat, lon, radiusKm } = args;
  const [hours, setHoursState] = useState(args.hours);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    coverage: CoveragePayload | null;
    summary: Summary | null;
    calendar: CalendarResponse | null;
    calendarError: string | null;
    observations: DetectionCollection | null;
    ask: AskResponse | null;
    step: string | null;
    error: string | null;
  }>({
    coverage: coverageCache,
    summary: null,
    calendar: null,
    calendarError: null,
    observations: null,
    ask: null,
    step: null,
    error: null,
  });

  const lastPoint = useRef("");
  const hoursRef = useRef(hours);
  hoursRef.current = hours;

  useEffect(() => {
    const point = `${bbox}|${lat}|${lon}|${radiusKm}`;
    const pointChanged = lastPoint.current !== point;
    let stale = false;

    const run = async () => {
      if (pointChanged) {
        lastPoint.current = point;
        setState((s) => ({
          ...s,
          summary: null,
          calendar: null,
          calendarError: null,
          observations: null,
          ask: null,
          error: null,
          step: "coverage",
        }));
      } else {
        setState((s) => ({ ...s, ask: null, error: null, step: "grounded answer" }));
      }

      try {
        let cov = coverageCache;
        if (pointChanged || !cov) {
          cov = await apiGet<CoveragePayload>("/api/coverage");
          coverageCache = cov;
          if (stale) return;
          setState((s) => ({ ...s, coverage: cov, step: "detections" }));
        }

        if (pointChanged) {
          const summary = await withRetry(() => apiGet<Summary>("/api/summary", { bbox }), stale);
          if (stale) return;
          setState((s) => ({ ...s, summary, step: "day-by-day coverage" }));

          // Non-fatal: a calendar we cannot read downgrades the verdict to UNKNOWN.
          try {
            const calendar = await withRetry(
              () => apiGet<CalendarResponse>("/api/calendar", { bbox }),
              stale,
            );
            if (stale) return;
            setState((s) => ({ ...s, calendar, calendarError: null, step: "strongest detections" }));
          } catch (err) {
            if (stale) return;
            setState((s) => ({
              ...s,
              calendar: null,
              calendarError: (err as Error).message,
              step: "strongest detections",
            }));
          }

          const observations = await withRetry(
            () => apiGet<DetectionCollection>("/api/observations", { bbox, limit: 6 }),
            stale,
          );
          if (stale) return;
          setState((s) => ({ ...s, observations, step: "grounded answer" }));
        }

        const ask = await apiPost<AskResponse>("/api/ask-the-earth", {
          lat,
          lon,
          radiusKm,
          hours: hoursRef.current,
          obsId: null,
        });
        if (stale) return;
        setState((s) => ({ ...s, ask, step: null }));
      } catch (err) {
        if (stale) return;
        setState((s) => ({ ...s, error: (err as Error).message, step: null }));
      }
    };

    // Coalesce rapid selections (globe clicks, slider drags) into one chain.
    const timer = window.setTimeout(run, 240);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [bbox, lat, lon, radiusKm, hours, nonce]);

  const setHours = useCallback((h: number) => setHoursState(h), []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, hours, setHours, reload };
}
