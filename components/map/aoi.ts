/**
 * AOI helpers for the fire map — pure functions, no React, no data.
 *
 * An AOI here is a rectangle `[west, south, east, north]` in EPSG:4326. It is
 * *always* a user-drawn or user-supplied extent, clipped to the active study
 * region, and it becomes an engine `bbox` parameter verbatim (`W,S,E,N`), which
 * is the same parameter /api/cells, /api/observations, /api/summary and
 * /api/report.csv already accept.
 *
 * Nothing in this file computes an area, a count or a density: those must come
 * from the engine so every displayed number has a response behind it.
 */

import { REGIONS } from "@/lib/regions";
import type { RegionDef } from "@/lib/regions";

export type Bbox = [number, number, number, number];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse `"W,S,E,N"` from a URL or a drag. Returns null for anything malformed. */
export function parseBbox(raw: string | null | undefined): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || !parts.every(isFiniteNumber)) return null;
  const [w, s, e, n] = parts;
  if (w >= e || s >= n) return null;
  if (w < -180 || e > 180 || s < -90 || n > 90) return null;
  return [w, s, e, n];
}

/** Engine query-parameter form. Four decimals ≈ 11 m at the equator. */
export function bboxParam(bbox: Bbox): string {
  return bbox.map((v) => Number(v.toFixed(4))).join(",");
}

/** Human form for a chip/label. */
export function bboxLabel(bbox: Bbox): string {
  return `${bbox[0].toFixed(2)}, ${bbox[1].toFixed(2)}, ${bbox[2].toFixed(2)}, ${bbox[3].toFixed(2)}`;
}

/** Build a bbox from two corners in any order (a drag can go any direction). */
export function bboxFromCorners(a: [number, number], b: [number, number]): Bbox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}

export function intersectBbox(a: Bbox, b: Bbox): Bbox | null {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  if (e - w <= 1e-6 || n - s <= 1e-6) return null;
  return [w, s, e, n];
}

export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return (
    inner[0] >= outer[0] - 1e-6 &&
    inner[1] >= outer[1] - 1e-6 &&
    inner[2] <= outer[2] + 1e-6 &&
    inner[3] <= outer[3] + 1e-6
  );
}

export function bboxCenter(bbox: Bbox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/**
 * Smallest drag that is still a meaningful extent. Roughly 0.02° ≈ 2 km, below
 * which a "rectangle" is a mis-click and would silently restrict every query to
 * a single cell.
 */
export const MIN_AOI_SPAN_DEG = 0.02;

export function isMeaningfulAoi(bbox: Bbox): boolean {
  return bbox[2] - bbox[0] >= MIN_AOI_SPAN_DEG && bbox[3] - bbox[1] >= MIN_AOI_SPAN_DEG;
}

/**
 * The study region that fully contains the AOI, if any. Used to push the AOI
 * into FiltersProvider — the provider's contract is a region id, so the AOI can
 * only be reflected there when it is genuinely inside one region.
 */
export function regionContaining(bbox: Bbox): RegionDef | null {
  const candidates = REGIONS.filter((r) => bboxContains(r.bbox, bbox));
  if (candidates.length === 0) return null;
  // Prefer the tightest containing region (global contains everything).
  return candidates.sort((a, b) => {
    const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
    const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
    return areaA - areaB;
  })[0];
}

/** Overlap fraction of the AOI that falls inside a region (0–1). */
export function overlapShare(bbox: Bbox, region: RegionDef): number {
  const hit = intersectBbox(bbox, region.bbox);
  if (!hit) return 0;
  const aoiArea = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const hitArea = (hit[2] - hit[0]) * (hit[3] - hit[1]);
  return aoiArea > 0 ? hitArea / aoiArea : 0;
}

/** Region that covers most of the AOI, even if it does not contain all of it. */
export function regionMostlyCovering(bbox: Bbox): { region: RegionDef; share: number } | null {
  let best: { region: RegionDef; share: number } | null = null;
  for (const region of REGIONS) {
    const share = overlapShare(bbox, region);
    if (share > 0 && (!best || share > best.share)) best = { region, share };
  }
  return best;
}
