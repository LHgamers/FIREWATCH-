import type { QueryValue } from "@/lib/api";
import type { RegionDef } from "@/lib/regions";
import type { MapFilterState } from "./types";

/** Map the local filter state onto engine query parameters (empty = unfiltered). */
export function filterQueryParams(
  f: MapFilterState,
  window?: { start: string; end: string },
): Record<string, QueryValue> {
  const confidence =
    f.confidence.length > 0 && f.confidence.length < 3 ? f.confidence.join(",") : undefined;
  return {
    sensor: f.sensor === "both" ? undefined : f.sensor,
    confidence,
    min_frp: f.minFrp > 0 ? f.minFrp : undefined,
    daynight: f.daynight || undefined,
    satellites: f.satellites.length ? f.satellites.join(",") : undefined,
    // Omit the dates when they already describe the whole stored window.
    start: f.start && f.start !== window?.start ? f.start : undefined,
    end: f.end && f.end !== window?.end ? f.end : undefined,
  };
}

export function bboxParam(bbox: [number, number, number, number]): string {
  return bbox.map((v) => Number(v.toFixed(4))).join(",");
}

/**
 * Intersect the current viewport with the study region so the observation query
 * never returns detections outside the selected region.
 */
export function clampBboxToRegion(
  bbox: [number, number, number, number],
  region: RegionDef,
): [number, number, number, number] | null {
  const [rw, rs, re, rn] = region.bbox;
  const w = Math.max(-180, Math.min(180, Math.min(bbox[0], bbox[2])));
  const e = Math.max(-180, Math.min(180, Math.max(bbox[0], bbox[2])));
  const s = Math.max(-85, Math.min(85, Math.min(bbox[1], bbox[3])));
  const n = Math.max(-85, Math.min(85, Math.max(bbox[1], bbox[3])));

  const west = Math.max(w, rw);
  const east = Math.min(e, re);
  const south = Math.max(s, rs);
  const north = Math.min(n, rn);

  if (east - west <= 0.0005 || north - south <= 0.0005) return null;
  return [west, south, east, north];
}

/** Cell size for the aggregated layer: coarse at world zoom, 1° otherwise. */
export function cellSizeForZoom(zoom: number): 1 | 2 {
  // Continental/global extents read as a heat field rather than a polka-dot grid
  // when the cells are coarser; national/regional scales keep 1° resolution.
  return zoom < 4.2 ? 2 : 1;
}
