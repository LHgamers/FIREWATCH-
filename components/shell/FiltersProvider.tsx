"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { REGION_MAP } from "@/lib/regions";

const STORAGE_KEY = "firewatch.region";

interface FiltersState {
  region: string;
  setRegion: (id: string) => void;
  /** True once the URL and localStorage have been read. */
  ready: boolean;
}

const FiltersContext = createContext<FiltersState | null>(null);

/** A region id the catalogue knows, or null. Never falls back to Global. */
function validRegion(value: string | null): string | null {
  if (!value) return null;
  const id = value.trim().toLowerCase();
  return REGION_MAP[id] ? id : null;
}

/**
 * A usable bbox from the query string, or null.
 *
 * Invalid geometry is ignored rather than replaced with the world: the engine
 * answers 400 for a bad bbox, so the UI must not invent a different area and
 * present its numbers under the user's link.
 */
function validBbox(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = parts;
  if (Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) return null;
  if (s >= n) return null;
  if (w === e) return null;
  return parts.join(",");
}

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [region, setRegionState] = useState("global");
  const [ready, setReady] = useState(false);

  // Initial resolution: an explicit `?bbox=` or `?region=` wins over the stored
  // preference, which wins over Global. The engine applies bbox over region, so
  // the UI keeps whatever region label the link carries without overriding it.
  useEffect(() => {
    let next = "global";
    try {
      const url = new URL(window.location.href);
      const linked = validRegion(url.searchParams.get("region"));
      const saved = validRegion(window.localStorage.getItem(STORAGE_KEY));
      next = linked ?? saved ?? "global";
    } catch {
      /* private mode or an unparsable URL: keep Global */
    }
    setRegionState(next);
    setReady(true);
  }, []);

  const setRegion = useCallback((id: string) => {
    const safe = REGION_MAP[id] ? id : "global";
    setRegionState(safe);
    try {
      window.localStorage.setItem(STORAGE_KEY, safe);
    } catch {
      /* ignore */
    }
    // Keep the address bar shareable without navigating. Only `region` is
    // touched, so a `?bbox=` link keeps its own parameter.
    try {
      const url = new URL(window.location.href);
      if (safe === "global") url.searchParams.delete("region");
      else url.searchParams.set("region", safe);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(() => ({ region, setRegion, ready }), [region, setRegion, ready]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersState {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used inside FiltersProvider");
  return ctx;
}

/**
 * Context read that tolerates being outside the provider.
 *
 * Data hooks use this to hold their first request until the region has been
 * resolved from the URL/localStorage. Readiness lives in provider state, not in
 * a module-level flag: React StrictMode mounts the provider twice, and a flag
 * that survives the remount would let a hook fetch `global` before the second
 * mount re-resolves the linked region.
 */
export function useFiltersMaybe(): FiltersState | null {
  return useContext(FiltersContext);
}

export { validBbox, validRegion };
