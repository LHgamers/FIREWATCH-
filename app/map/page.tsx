"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  CalendarDays, Clock3, Crosshair, FileText, History, Info, SlidersHorizontal, SquareDashed, TriangleAlert, X,
} from "lucide-react";

import { useFilters } from "@/components/shell/FiltersProvider";
import { useMeta } from "@/lib/hooks";
import { REGION_MAP } from "@/lib/regions";
import { PlaceSearch } from "@/components/ask/PlaceSearch";
import type { PlaceResult } from "@/lib/geocode";
import type { DetectionCollection, DetectionProps, TimeseriesPoint } from "@/lib/types";
import { Badge, Panel, PanelHead } from "@/components/ui/primitives";
import { cn, formatDateTime, formatInt, relativeAge } from "@/lib/format";
import { BASEMAP_MAP } from "@/lib/map-style";
import type { BasemapMode } from "@/lib/map-style";
import { MapCanvas } from "@/components/map/MapCanvas";
import { FilterRail } from "@/components/map/FilterRail";
import { StatsStrip } from "@/components/map/StatsStrip";
import { AnalysisRail } from "@/components/map/AnalysisRail";
import type { HotspotItem } from "@/components/map/AnalysisRail";
import { Timeline } from "@/components/map/Timeline";
import type { TimelineMode } from "@/components/map/Timeline";
import { CoverageNotice } from "@/components/map/CoverageNotice";
import { useEngineQuery } from "@/components/map/useEngineQuery";
import { bboxParam, cellSizeForZoom, clampBboxToRegion, filterQueryParams } from "@/components/map/query";
import { datasetLabel } from "@/components/map/popupContent";
import {
  bboxLabel, bboxParam as aoiParam, intersectBbox, isMeaningfulAoi, parseBbox, regionContaining,
} from "@/components/map/aoi";
import type { Bbox } from "@/components/map/aoi";
import type {
  CellsResponse,
  EngagementPoint,
  MapFilterState,
  RegionTotals,
  SelectedDetection,
  ViewCommand,
  ViewPort,
} from "@/components/map/types";

const MAX_POINTS = 20000;

function defaultFilters(start: string, end: string): MapFilterState {
  return {
    sensor: "both",
    confidence: ["high", "nominal", "low"],
    minFrp: 0,
    daynight: "",
    satellites: [],
    start,
    end,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Whole days between two ISO dates (b − a), UTC. */
function dayOffset(a: string, b: string): number | null {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86_400_000);
}

export default function MapPage() {
  // useSearchParams needs a Suspense boundary for the production build.
  return (
    <Suspense fallback={<div className="p-6 text-[12px] text-muted">Preparing the map…</div>}>
      <MapInner />
    </Suspense>
  );
}

function MapInner() {
  const searchParams = useSearchParams();
  const { region: regionId, setRegion, ready: filtersReady } = useFilters();
  const { meta, loading: metaLoading, error: metaError } = useMeta();
  const region = REGION_MAP[regionId] ?? REGION_MAP.global;

  const coverageDays = useMemo(() => meta?.coverage.days ?? [], [meta]);
  const mapReady = filtersReady && meta !== null;
  const windowStart = meta?.coverage.first ?? "";
  const windowEnd = meta?.coverage.last ?? "";
  const lastSuccessAt = meta?.freshness?.lastSuccessAt ?? null;
  const engineTotal = meta?.engine.observations ?? null;
  const sensorDays = meta?.coverage.sensorDays ?? null;

  const [filters, setFilters] = useState<MapFilterState>(() => defaultFilters("", ""));
  const [view, setView] = useState<ViewPort>({ zoom: 1.5, bbox: region.bbox });
  const [mode, setMode] = useState<"cells" | "points">("cells");
  const [basemap, setBasemap] = useState<BasemapMode>("satellite");
  const [imageryDate, setImageryDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [analyzeArmed, setAnalyzeArmed] = useState(false);
  const [aoiArmed, setAoiArmed] = useState(false);
  const [aoi, setAoi] = useState<Bbox | null>(null);
  /** Set when a deep-linked AOI had to be clipped or fell outside the region. */
  const [aoiNotice, setAoiNotice] = useState<string | null>(null);
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("window");
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<SelectedDetection | null>(null);
  const [engagement, setEngagement] = useState<EngagementPoint | null>(null);
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  const [command, setCommand] = useState<ViewCommand | null>(null);
  const nonceRef = useRef(0);

  /* Lock the query window to the stored coverage as soon as /api/meta lands. */
  useEffect(() => {
    if (!windowStart || !windowEnd) return;
    setFilters((f) => (f.start && f.end ? f : { ...f, start: f.start || windowStart, end: f.end || windowEnd }));
    setImageryDate((d) => d || windowEnd);
  }, [windowStart, windowEnd]);

  const handleViewChange = useCallback((next: ViewPort) => {
    setView(next);
    setMode((prev) => (next.zoom >= 5.2 ? "points" : next.zoom <= 4.8 ? "cells" : prev));
  }, []);

  /* ------------------------------------------------------------------ */
  /* Deep links: /map?bbox=W,S,E,N&lat=&lon=&obs=                        */
  /* ------------------------------------------------------------------ */
  const appliedLink = useRef(false);
  useEffect(() => {
    if (appliedLink.current) return;
    if (!meta) return;
    const rawBbox = searchParams.get("bbox");
    const rawStart = searchParams.get("start");
    const rawEnd = searchParams.get("end");
    const rawLat = searchParams.get("lat");
    const rawLon = searchParams.get("lon");
    const obsId = searchParams.get("obs") ?? searchParams.get("id");
    if (!rawBbox && !rawStart && !rawEnd && !rawLat && !rawLon && !obsId) {
      appliedLink.current = true;
      return;
    }
    appliedLink.current = true;

    nonceRef.current += 1;
    let linkedBbox: Bbox | null = null;
    if (rawStart || rawEnd) {
      const validDate = (value: string | null) =>
        value !== null &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`));
      if (rawStart && rawEnd && validDate(rawStart) && validDate(rawEnd) && rawStart <= rawEnd) {
        setFilters((current) => ({ ...current, start: rawStart, end: rawEnd }));
      } else {
        setAoiNotice("The linked date range is invalid; the map retained its current date filters.");
      }
    }

    if (rawBbox) {
      const parsed = parseBbox(rawBbox);
      if (!parsed) {
        setAoiNotice(`The linked bbox "${rawBbox}" is not a valid W,S,E,N extent, so the map ignored it.`);
      } else {
        const clipped = intersectBbox(parsed, region.bbox);
        if (!clipped || !isMeaningfulAoi(clipped)) {
          setAoiNotice(
            `The linked area of interest does not overlap ${region.name}. The map stayed on the study region; the link was not silently applied.`,
          );
        } else {
          linkedBbox = clipped;
          setAoi(clipped);
          setMode("points");
          setCommand({ kind: "bbox", nonce: nonceRef.current, bbox: clipped });
          const containing = regionContaining(clipped);
          if (containing && containing.id !== region.id) setRegion(containing.id);
          const wasClipped =
            clipped[0] !== parsed[0] || clipped[1] !== parsed[1] || clipped[2] !== parsed[2] || clipped[3] !== parsed[3];
          if (wasClipped) {
            setAoiNotice(`The linked area of interest was clipped to ${region.name}: ${bboxLabel(clipped)}.`);
          }
        }
      }
    }

    const lat = rawLat !== null ? Number(rawLat) : null;
    const lon = rawLon !== null ? Number(rawLon) : null;
    const point =
      lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon) &&
      Math.abs(lat) <= 89.9 && Math.abs(lon) <= 180
        ? ({ lat, lon } as { lat: number; lon: number })
        : null;

    if (point) {
      setEngagement({ lat: point.lat, lon: point.lon, obsId: obsId ?? null });
      if (!linkedBbox) {
        nonceRef.current += 1;
        setCommand({ kind: "focus", nonce: nonceRef.current, lat: point.lat, lon: point.lon, zoom: 8 });
      }
    }
    // Selection of a deep-linked observation is resolved by the effect below,
    // because /api/observation/{id} may not be loaded yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  const linkedObsId = searchParams.get("obs") ?? searchParams.get("id");

  /* Resolve a deep-linked observation id through the engine (no local copy). */
  useEffect(() => {
    if (!linkedObsId || !meta) return;
    let alive = true;
    fetch(`/api/observation/${encodeURIComponent(linkedObsId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: Record<string, unknown> | null) => {
        if (!alive || !payload) return;
        const lat = typeof payload.lat === "number" ? payload.lat : null;
        const lon = typeof payload.lon === "number" ? payload.lon : null;
        if (lat === null || lon === null) return;
        const props: DetectionProps = {
          id: String(payload.id ?? linkedObsId),
          sensor: payload.sensor === "viirs" ? "viirs" : "modis",
          instrument: String(payload.instrument ?? ""),
          satellite: String(payload.satellite ?? ""),
          acqDate: String(payload.acq_date ?? payload.acqDate ?? ""),
          acqTime: String(payload.acq_time ?? payload.acqTime ?? ""),
          ts: Number(payload.ts ?? 0),
          lat,
          lon,
          frp: typeof payload.frp === "number" ? payload.frp : null,
          confidence: String(payload.confidence ?? ""),
          confidencePct: typeof payload.confidence_pct === "number" ? payload.confidence_pct : null,
          confidenceClass:
            payload.confidence_class === "low" || payload.confidence_class === "nominal" || payload.confidence_class === "high"
              ? payload.confidence_class
              : null,
          brightness: typeof payload.brightness === "number" ? payload.brightness : null,
          brightT31: typeof payload.bright_t31 === "number" ? payload.bright_t31 : null,
          scan: typeof payload.scan === "number" ? payload.scan : null,
          track: typeof payload.track === "number" ? payload.track : null,
          daynight: typeof payload.daynight === "string" ? payload.daynight : null,
          version: String(payload.version ?? ""),
          source: String(payload.source ?? ""),
        };
        setSelected({ ...props, dataset: datasetLabel(props.source) });
        setEngagement({ lat, lon, obsId: props.id });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [linkedObsId, meta]);

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */
  const filterParams = useMemo(
    () => filterQueryParams(filters, { start: windowStart, end: windowEnd }),
    [filters, windowStart, windowEnd],
  );
  const cellSize = cellSizeForZoom(view.zoom);
  const clamped = useMemo(() => clampBboxToRegion(view.bbox, region), [view.bbox, region]);

  /** The area every query is restricted to: the drawn AOI, else the viewport ∩ region. */
  const queryBbox = aoi ?? clamped;

  const scopeParams = useMemo(
    () => (aoi ? { bbox: aoiParam(aoi) } : { region: region.id }),
    [aoi, region.id],
  );

  // The cell grid is always fetched: it drives the aggregated layer at low zoom
  // and the region/AOI totals in the strip and analysis rail at every zoom.
  const cellsQuery = useEngineQuery<CellsResponse>(
    "/api/cells",
    { ...scopeParams, cell: mode === "cells" ? cellSize : 4, ...filterParams },
    mapReady,
  );
  const detectionsQuery = useEngineQuery<DetectionCollection>(
    "/api/observations",
    { bbox: queryBbox ? bboxParam(queryBbox) : undefined, limit: MAX_POINTS, ...filterParams },
    mapReady && mode === "points" && queryBbox !== null,
  );

  /* Per-day counts for the current area and filters (timeline bars). */
  const seriesParams = useMemo(() => {
    const { start: _start, end: _end, ...rest } = filterParams;
    return { ...scopeParams, ...rest };
  }, [filterParams, scopeParams]);
  const seriesQuery = useEngineQuery<{ series: TimeseriesPoint[]; days: string[] }>(
    "/api/timeseries",
    seriesParams,
    mapReady && coverageDays.length > 0,
  );

  const totals = useMemo<RegionTotals | null>(() => {
    const cells = cellsQuery.data?.cells;
    if (!cells) return null;
    let total = 0;
    let modis = 0;
    let viirs = 0;
    let high = 0;
    let frpSum = 0;
    let maxFrp = 0;
    for (const c of cells) {
      total += c.count;
      modis += c.modis;
      viirs += c.viirs;
      high += c.high;
      frpSum += c.frp;
      if (c.maxFrp > maxFrp) maxFrp = c.maxFrp;
    }
    return { total, modis, viirs, high, frpSum, maxFrp, cells: cells.length };
  }, [cellsQuery.data]);

  const activeCount = useMemo(() => {
    let n = 0;
    if (filters.sensor !== "both") n += 1;
    if (filters.confidence.length !== 3) n += 1;
    if (filters.minFrp > 0) n += 1;
    if (filters.daynight !== "") n += 1;
    if (filters.satellites.length > 0) n += 1;
    if (windowStart && filters.start && filters.start !== windowStart) n += 1;
    if (windowEnd && filters.end && filters.end !== windowEnd) n += 1;
    if (aoi) n += 1;
    return n;
  }, [filters, windowStart, windowEnd, aoi]);

  const resetFilters = useCallback(() => {
    setFilters(defaultFilters(windowStart, windowEnd));
    setAoi(null);
    setAoiNotice(null);
    setPlaceLabel(null);
    setTimelineMode("window");
    setPlaying(false);
  }, [windowStart, windowEnd]);

  const patchFilters = useCallback((patch: Partial<MapFilterState>) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  /* ------------------------------------------------------------------ */
  /* AOI                                                                */
  /* ------------------------------------------------------------------ */
  const handleAoiChange = useCallback(
    (next: Bbox | null) => {
      setAoiNotice(null);
      setPlaceLabel(null);
      if (!next) {
        setAoi(null);
        return;
      }
      const clipped = intersectBbox(next, region.bbox);
      if (!clipped || !isMeaningfulAoi(clipped)) {
        setAoiNotice("That rectangle is smaller than ~2 km across, so it was ignored rather than querying a single cell.");
        return;
      }
      setAoi(clipped);
      setAoiArmed(false);
      setMode("points");
      nonceRef.current += 1;
      setCommand({ kind: "bbox", nonce: nonceRef.current, bbox: clipped });
      const containing = regionContaining(clipped);
      if (containing && containing.id !== region.id) setRegion(containing.id);
      else if (!containing) {
        setAoiNotice(
          `The area of interest is not fully inside one study region. The study region stays ${region.name} and every query is still clipped to it.`,
        );
      }
    },
    [region, setRegion],
  );

  /* ------------------------------------------------------------------ */
  /* Timeline                                                           */
  /* ------------------------------------------------------------------ */
  const activeDay = timelineMode === "day" ? filters.start || coverageDays[0] || null : null;

  const handleDayChange = useCallback(
    (day: string) => {
      setTimelineMode("day");
      setFilters((f) => ({ ...f, start: day, end: day }));
    },
    [],
  );

  const handleTimelineMode = useCallback(
    (next: TimelineMode) => {
      setTimelineMode(next);
      if (next === "window") {
        setPlaying(false);
        setFilters((f) => ({ ...f, start: windowStart, end: windowEnd }));
      } else if (coverageDays.length > 0) {
        setFilters((f) => ({ ...f, start: f.start || windowEnd || coverageDays[0], end: f.start || windowEnd || coverageDays[0] }));
      }
    },
    [coverageDays, windowStart, windowEnd],
  );

  /* ------------------------------------------------------------------ */
  /* Selection                                                          */
  /* ------------------------------------------------------------------ */
  const handleSelect = useCallback((detection: DetectionProps | null) => {
    if (!detection) {
      setSelected(null);
      setEngagement(null);
      return;
    }
    setSelected({ ...detection, dataset: datasetLabel(detection.source) });
    setEngagement({ lat: detection.lat, lon: detection.lon, obsId: detection.id });
    setAnalyzeArmed(false);
  }, []);

  const handlePick = useCallback((lat: number, lon: number) => {
    setSelected(null);
    setEngagement({ lat, lon, obsId: null });
    setAnalyzeArmed(false);
  }, []);

  const focusEngagement = useCallback(() => {
    const el = document.getElementById("analysis-rail");
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }, []);

  const focusMap = useCallback((lat: number, lon: number) => {
    nonceRef.current += 1;
    setCommand({ kind: "focus", nonce: nonceRef.current, lat, lon, zoom: Math.max(view.zoom, 7) });
  }, [view.zoom]);

  const resetView = useCallback(() => {
    nonceRef.current += 1;
    setCommand({ kind: "reset", nonce: nonceRef.current });
  }, []);

  const handlePlaceSelect = useCallback(
    (place: PlaceResult) => {
      const builtinId = place.source === "builtin-region" ? place.key.slice("builtin:".length) : null;
      const builtin = builtinId ? REGION_MAP[builtinId] : null;
      const isCoordinate = place.kind === "coordinates";

      setRegion(builtin?.id ?? "global");
      setSelected(null);
      setEngagement(null);
      setAoiNotice(null);
      setPlaceLabel(place.name);
      setMode(builtin || isCoordinate ? "cells" : "points");
      setAoi(builtin || isCoordinate ? null : place.bbox);

      nonceRef.current += 1;
      setCommand(
        isCoordinate
          ? { kind: "focus", nonce: nonceRef.current, lat: place.lat, lon: place.lon, zoom: 8 }
          : { kind: "bbox", nonce: nonceRef.current, bbox: builtin?.bbox ?? place.bbox },
      );

      const url = new URL(window.location.href);
      url.searchParams.delete("bbox");
      url.searchParams.delete("lat");
      url.searchParams.delete("lon");
      url.searchParams.delete("obs");
      url.searchParams.delete("id");
      if (isCoordinate) {
        url.searchParams.set("lat", String(place.lat));
        url.searchParams.set("lon", String(place.lon));
      } else if (!builtin) {
        url.searchParams.set("bbox", bboxParam(place.bbox));
      }
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    },
    [setRegion],
  );

  /* Region changes invalidate the previous target and any AOI drawn elsewhere. */
  useEffect(() => {
    setSelected(null);
    setEngagement(null);
    setAoi((current) => {
      if (!current) return current;
      const clipped = intersectBbox(current, region.bbox);
      return clipped && isMeaningfulAoi(clipped) ? clipped : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region.id]);

  /* Keyboard: A arms the point query, Shift+A the rectangle, Esc cancels. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.getAttribute("role") === "slider");
      if (typing) return;

      if (event.key === "Escape") {
        if (aoiArmed) {
          setAoiArmed(false);
        } else if (analyzeArmed) {
          setAnalyzeArmed(false);
        } else if (engagement) {
          setEngagement(null);
          setSelected(null);
        }
        return;
      }
      if ((event.key === "a" || event.key === "A") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (event.shiftKey) {
          setAoiArmed((armed) => !armed);
          setAnalyzeArmed(false);
        } else {
          setAnalyzeArmed((armed) => !armed);
          setAoiArmed(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [analyzeArmed, aoiArmed, engagement]);

  /* ------------------------------------------------------------------ */
  /* Derived presentation                                               */
  /* ------------------------------------------------------------------ */
  const hotspots = useMemo<HotspotItem[]>(() => {
    if (mode === "cells") {
      return (cellsQuery.data?.cells ?? [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 6)
        .map((c) => ({
          key: `${c.lat},${c.lon}`,
          lat: c.lat,
          lon: c.lon,
          count: c.count,
          frp: c.maxFrp,
          sensor: c.modis > 0 && c.viirs > 0 ? "both" : c.modis > 0 ? "modis" : "viirs",
        }));
    }
    const features = detectionsQuery.data?.features ?? [];
    return [...features]
      .sort((a, b) => (b.properties.frp ?? 0) - (a.properties.frp ?? 0))
      .slice(0, 6)
      .map((f) => ({
        key: f.properties.id,
        lat: f.properties.lat,
        lon: f.properties.lon,
        count: null,
        frp: f.properties.frp,
        sensor: f.properties.sensor,
      }));
  }, [mode, cellsQuery.data, detectionsQuery.data]);

  const activeQuery = mode === "cells" ? cellsQuery : detectionsQuery;
  const firstLoad =
    (!mapReady && metaError === null) ||
    (metaLoading && meta === null) ||
    (mapReady && activeQuery.loading && activeQuery.data === null);
  const error = activeQuery.error ?? metaError;
  const showError =
    metaError !== null ||
    (activeQuery.error !== null && activeQuery.data === null);
  const visibleCount =
    mode === "cells" ? cellsQuery.data?.cells.length ?? null : detectionsQuery.data?.meta.returned ?? null;
  const empty =
    !firstLoad &&
    error === null &&
    (mode === "cells"
      ? cellsQuery.data !== null && cellsQuery.data.cells.length === 0
      : detectionsQuery.data !== null && detectionsQuery.data.features.length === 0);
  const outsideRegion = mode === "points" && queryBbox === null;
  const showEmpty = (empty || outsideRegion) && !showError;

  const mapHeight = expanded ? "calc(100vh - 180px)" : "min(78vh, 900px)";
  const basemapLabel = BASEMAP_MAP[basemap].label;
  const windowLabel = `${filters.start || windowStart || "—"} → ${filters.end || windowEnd || "—"}`;

  /* Imagery is a different product with a different date. Say so. */
  const imageryGap =
    imageryDate && windowEnd && imageryDate < windowStart
      ? dayOffset(imageryDate, windowEnd)
      : null;

  /* Coverage ledger params: the same AOI + filters the map is showing. */
  const ledgerParams = useMemo(
    () => ({ ...scopeParams, ...filterParams }),
    [scopeParams, filterParams],
  );

  const retryAll = () => {
    cellsQuery.retry();
    detectionsQuery.retry();
    seriesQuery.retry();
  };

  const aoiReportHref = aoi
    ? `/report?bbox=${aoiParam(aoi)}${timelineMode === "day" && filters.start ? `&start=${filters.start}&end=${filters.start}` : ""}`
    : null;
  // Hand the map's current extent to the calendar and the historical explorer.
  // Without this the two analysis views opened on whatever region was stored,
  // not on the area the user had just selected here.
  const extentParam = aoiParam(aoi ?? region.bbox);
  const aoiCalendarHref = `/calendar?bbox=${extentParam}`;
  const aoiHistoryHref = `/history?bbox=${extentParam}`;

  return (
    <div className="space-y-3">
      <div className="panel relative z-30 grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end min-[1600px]:grid-cols-[minmax(280px,1fr)_auto_minmax(250px,auto)]">
        <PlaceSearch
          onSelect={handlePlaceSelect}
          currentName={placeLabel ?? (aoi ? "Area of interest" : null)}
          className="min-w-0"
        />

        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-[112px]">
            <span className="kicker text-[9px]">From · UTC date</span>
            <input
              type="date"
              min="2000-01-01"
              max={new Date().toISOString().slice(0, 10)}
              value={filters.start}
              onChange={(event) => {
                const start = event.target.value;
                setFilters((current) => ({
                  ...current,
                  start,
                  end: current.end && current.end < start ? start : current.end,
                }));
              }}
              className="mt-1 w-full rounded-md border border-line bg-elevated/50 px-2 py-2 font-mono text-[10.5px] text-ink outline-none focus:border-cyan/50 disabled:opacity-40"
              aria-label="Start date"
            />
          </label>
          <label className="block min-w-[112px]">
            <span className="kicker text-[9px]">To · UTC date</span>
            <input
              type="date"
              min="2000-01-01"
              max={new Date().toISOString().slice(0, 10)}
              value={filters.end}
              onChange={(event) => {
                const end = event.target.value;
                setFilters((current) => ({
                  ...current,
                  end,
                  start: current.start && current.start > end ? end : current.start,
                }));
              }}
              className="mt-1 w-full rounded-md border border-line bg-elevated/50 px-2 py-2 font-mono text-[10.5px] text-ink outline-none focus:border-cyan/50 disabled:opacity-40"
              aria-label="End date"
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:col-span-2 min-[1600px]:col-span-1 min-[1600px]:min-w-[280px]">
          <div className="rounded-md border border-line/60 bg-elevated/20 px-2.5 py-2">
            <p className="kicker text-[8.5px]">Latest available observation</p>
            <p className="mt-1 font-mono text-[10.5px] text-ink">{windowEnd || "Not reported"}</p>
          </div>
          <div
            className={cn(
              "rounded-md border px-2.5 py-2",
              meta?.freshness?.state === "stale" ? "border-ember/35 bg-ember/[0.05]" : "border-line/60 bg-elevated/20",
            )}
            title={lastSuccessAt ? `Last successful source check: ${lastSuccessAt}` : "No successful update reported"}
          >
            <p className="kicker inline-flex items-center gap-1 text-[8.5px]">
              <Clock3 size={9} /> Last successful data update
            </p>
            <p className="mt-1 truncate font-mono text-[10.5px] text-ink">
              {lastSuccessAt ? `${formatDateTime(lastSuccessAt)} · ${relativeAge(lastSuccessAt)}` : "Not reported"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:hidden">
        <button
          type="button"
          className={cn("btn", mobileFilters && "btn-primary")}
          onClick={() => setMobileFilters((v) => !v)}
          aria-expanded={mobileFilters}
        >
          <SlidersHorizontal size={13} />
          Filters
          {activeCount > 0 ? <Badge tone="cyan">{activeCount}</Badge> : null}
        </button>
        <button
          type="button"
          className={cn("btn", analyzeArmed && "btn-primary")}
          onClick={() => { setAnalyzeArmed((v) => !v); setAoiArmed(false); }}
        >
          <Crosshair size={13} />
          {analyzeArmed ? "Pick a point…" : "Analyze point"}
        </button>
        <button
          type="button"
          className={cn("btn", aoiArmed && "btn-primary")}
          onClick={() => { setAoiArmed((v) => !v); setAnalyzeArmed(false); }}
        >
          <SquareDashed size={13} />
          {aoiArmed ? "Draw area…" : "Select area"}
        </button>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-muted/70">
          {region.name}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)] min-[1600px]:grid-cols-[250px_minmax(0,1fr)_320px]">
        <div className={cn("fw-slide-left-in", mobileFilters ? "block" : "hidden", "lg:block lg:sticky lg:top-[86px] lg:self-start")}>
          <FilterRail
            region={region}
            filters={filters}
            onChange={patchFilters}
            onReset={resetFilters}
            days={coverageDays}
            activeCount={activeCount}
            basemap={basemap}
            onBasemapChange={setBasemap}
            imageryDate={imageryDate || windowEnd}
            onImageryDateChange={setImageryDate}
            filteredTotal={totals?.total ?? null}
            loading={cellsQuery.loading}
            aoi={aoi}
            onClearAoi={() => handleAoiChange(null)}
            onClose={() => setMobileFilters(false)}
          />
        </div>

        <Panel className="min-w-0 self-start overflow-hidden">
          <PanelHead
            title="Fire Map"
            hint={`${region.name}${aoi ? " · AOI" : ""} · ${basemapLabel}`}
            action={
              <div className="flex items-center gap-1.5">
                <Badge tone={mode === "cells" ? "cyan" : "warn"}>{mode === "cells" ? `${cellSize}° grid` : "clustered"}</Badge>
                {detectionsQuery.data && mode === "points" ? (
                  <Badge tone="muted">{formatInt(detectionsQuery.data.meta.returned)} pts</Badge>
                ) : null}
              </div>
            }
          />
          <div className="relative overflow-hidden" style={{ height: mapHeight, transition: "height 240ms ease" }}>
            <MapCanvas
              region={region}
              mode={mode}
              cells={cellsQuery.data?.cells ?? null}
              detections={detectionsQuery.data}
              basemap={basemap}
              imageryDate={imageryDate || windowEnd}
              loading={activeQuery.loading}
              analyzeArmed={analyzeArmed}
              aoiArmed={aoiArmed}
              aoi={aoi}
              expanded={expanded}
              selectedId={selected?.id ?? null}
              command={command}
              freshDate={windowEnd || null}
              onViewChange={handleViewChange}
              onBasemapChange={setBasemap}
              onSelect={handleSelect}
              onPick={handlePick}
              onAoiChange={handleAoiChange}
              onToggleAoi={() => { setAoiArmed((v) => !v); setAnalyzeArmed(false); }}
              onAskFocused={focusEngagement}
              onToggleAnalyze={() => { setAnalyzeArmed((v) => !v); setAoiArmed(false); }}
              onToggleExpand={() => setExpanded((v) => !v)}
            />

            {firstLoad || showError || showEmpty ? (
              <div className="absolute right-3 top-3 z-20 max-w-[min(360px,calc(100%-5rem))]">
                {firstLoad ? (
                  <div role="status" className="flex items-center gap-2 rounded-full border border-line/70 bg-panel/90 px-3 py-1.5 text-[10px] text-muted shadow-panel backdrop-blur-md">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
                    {meta === null ? "Loading observation coverage" : "Loading satellite detections"}
                  </div>
                ) : null}
                {showError ? (
                  <div role="status" className="flex items-center gap-2 rounded-lg border border-ember/35 bg-panel/95 px-3 py-2 text-[10px] text-muted shadow-panel backdrop-blur-md">
                    <TriangleAlert size={12} className="shrink-0 text-ember" />
                    <span>Fire activity data is temporarily unavailable. The map and basemap controls still work.</span>
                    <button
                      type="button"
                      onClick={() => metaError && meta === null ? window.location.reload() : retryAll()}
                      className="shrink-0 font-medium text-cyan hover:text-ink"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {showEmpty ? (
                  <div role="status" className="flex items-center gap-2 rounded-full border border-line/70 bg-panel/90 px-3 py-1.5 text-[10px] text-muted shadow-panel backdrop-blur-md">
                    <Info size={12} className="shrink-0 text-cyan" />
                    {outsideRegion
                      ? `Pan into ${region.name} to see its detections.`
                      : "No detections match these filters in the stored observation window."}
                  </div>
                ) : null}
              </div>
            ) : null}

            {error && activeQuery.data !== null ? (
              <button
                type="button"
                onClick={retryAll}
                className="fw-sheet-in absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-ember/40 bg-panel/95 px-3 py-1 font-mono text-[10px] text-ember backdrop-blur-md"
              >
                <TriangleAlert size={11} className="mr-1 inline" />
                Data refresh failed · retry
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line/60 px-3 py-2 font-mono text-[9.5px] leading-relaxed text-muted/70">
            <p>
              NASA FIRMS MODIS C6.1 + VIIRS 375 m ·{" "}
              {basemap === "satellite"
                ? "Esri satellite reference mosaic · date unspecified"
                : `${basemapLabel} · NASA GIBS composite ${imageryDate || "date unavailable"}`} · fire window{" "}
              <span className="text-muted">{windowLabel}</span>
            </p>
            <p className="tabular-nums">
              z {view.zoom.toFixed(1)} · {mode === "cells" ? "grid" : "pts"}{" "}
              {visibleCount === null ? "—" : formatInt(visibleCount)} · bbox{" "}
              {bboxParam(queryBbox ?? region.bbox)}
            </p>
          </div>
        </Panel>

        <div id="analysis-rail" className="fw-slide-left-in scroll-mt-24 lg:col-span-2 min-[1600px]:col-span-1 min-[1600px]:self-start"
          style={{ "--fw-delay": "80ms" } as React.CSSProperties}>
          <AnalysisRail
            region={region}
            selected={selected}
            engagement={engagement}
            onCloseEngagement={() => setEngagement(null)}
            onClearSelection={() => {
              setSelected(null);
              setEngagement(null);
            }}
            hotspots={hotspots}
            hotspotsLabel={mode === "cells" ? "Top cells" : "Hottest in view"}
            onFocus={focusMap}
            mode={mode}
            totals={totals}
            loading={cellsQuery.loading}
            analyzeArmed={analyzeArmed}
            onArmAnalyze={() => { setAnalyzeArmed(true); setAoiArmed(false); }}
          />
        </div>
      </div>

      <StatsStrip
        region={region}
        totals={totals}
        loading={cellsQuery.loading}
        activeCount={activeCount}
        windowStart={windowStart}
        windowEnd={windowEnd}
        windowDays={coverageDays.length}
        freshness={lastSuccessAt}
        mode={mode}
        visibleCount={visibleCount}
        engineTotal={engineTotal}
        aoiBbox={aoi}
      />

      <Timeline
        days={coverageDays}
        series={seriesQuery.data?.series ?? null}
        loading={seriesQuery.loading}
        error={seriesQuery.error}
        mode={timelineMode}
        activeDay={activeDay ?? (timelineMode === "window" ? windowEnd : null)}
        onModeChange={handleTimelineMode}
        onDayChange={handleDayChange}
        playing={playing}
        onPlayStateChange={setPlaying}
      />

      {/* ---------------------------------------------------------------- */}
      {/* Evidence strip: AOI, coverage ledger, imagery date honesty        */}
      {/* ---------------------------------------------------------------- */}
      <Panel>
        <PanelHead
          title="Query provenance"
          hint="What the numbers above are computed over"
          action={
            <div className="flex items-center gap-1.5">
              <Badge tone={aoi ? "cyan" : "muted"}>{aoi ? "area of interest" : "study region"}</Badge>
              {timelineMode === "day" ? <Badge tone="warn">single day</Badge> : <Badge tone="muted">full window</Badge>}
            </div>
          }
        />
        <div className="grid gap-3 p-3.5 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/70">Extent (W, S, E, N)</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-ink">
                  {aoi ? bboxLabel(aoi) : region.bbox.map((v) => v.toFixed(2)).join(", ")}
                </p>
                <p className="mt-1 font-mono text-[9px] text-muted/70">
                  {aoi ? "drawn or linked area, clipped to the study region" : `study region · ${region.name}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {aoi ? (
                  <button type="button" className="btn btn-ghost px-2 py-1 text-[10.5px]" onClick={() => handleAoiChange(null)}>
                    <X size={11} /> Clear AOI
                  </button>
                ) : null}
                {aoiReportHref ? (
                  <Link href={aoiReportHref} className="btn px-2 py-1 text-[10.5px]">
                    <FileText size={11} /> Report this area
                  </Link>
                ) : null}
                <Link href={aoiCalendarHref} className="btn btn-ghost px-2 py-1 text-[10.5px]" title="Open the burning calendar for this extent">
                  <CalendarDays size={11} /> Calendar
                </Link>
                <Link href={aoiHistoryHref} className="btn btn-ghost px-2 py-1 text-[10.5px]" title="Open the historical explorer for this extent">
                  <History size={11} /> History
                </Link>
              </div>
            </div>

            <div className="space-y-1 border-t border-line/40 pt-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/70">Sensor delivery</p>
              {sensorDays ? (
                <p className="font-mono text-[10px] leading-relaxed text-muted">
                  MODIS {sensorDays.modis ?? 0} of {coverageDays.length} stored days with delivery · VIIRS{" "}
                  {sensorDays.viirs ?? 0} of {coverageDays.length} · window {windowLabel}
                </p>
              ) : (
                <p className="font-mono text-[10px] text-muted">Per-sensor delivery counts are unavailable for this window.</p>
              )}
              <p className="text-[10.5px] leading-relaxed text-muted/80">
                Days outside this window are unknown, not zero. The ledger below is the engine&apos;s own per-day
                state for this exact area and filter set.
              </p>
            </div>

            {aoiNotice ? (
              <div className="flex items-start gap-2 rounded-md border border-ember/30 bg-ember/[0.06] px-2.5 py-2">
                <TriangleAlert size={12} className="mt-0.5 shrink-0 text-ember" />
                <p className="text-[10.5px] leading-relaxed text-muted">{aoiNotice}</p>
              </div>
            ) : null}

            {imageryGap !== null && imageryGap > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-line/70 bg-elevated/25 px-2.5 py-2">
                <Info size={12} className="mt-0.5 shrink-0 text-cyan/80" />
                <p className="text-[10.5px] leading-relaxed text-muted">
                  The imagery composite is <span className="text-ink">{imageryGap} day{imageryGap === 1 ? "" : "s"}</span>{" "}
                  older than the fire window ({imageryDate} vs {windowStart} → {windowEnd}). GIBS has not published a
                  true-colour composite for these dates; the background is reference imagery, not a snapshot of the
                  detections.
                </p>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            {activeDay ? (
              <CoverageNotice date={activeDay} params={ledgerParams} />
            ) : (
              <div className="rounded-md border border-line/70 bg-elevated/25 px-2.5 py-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">Coverage ledger</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted">
                  Switch the timeline to a single day to read that day&apos;s per-sensor state. The window view
                  aggregates {coverageDays.length} stored days and never fills a missing day with a zero.
                </p>
              </div>
            )}
            <p className="font-mono text-[9px] leading-relaxed text-muted/70">
              FRP is reported in MW exactly as NASA publishes it. A thermal anomaly is not a wildfire, and this
              platform is not an emergency service.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
