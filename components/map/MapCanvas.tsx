"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FullscreenControl,
  Map as MapLibreMapClass,
  NavigationControl,
  Popup as MapLibrePopup,
  ScaleControl,
} from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection, Point as GeoPoint } from "geojson";
import { Crosshair, LocateFixed, Maximize2, Minimize2, MousePointerClick, SquareDashed, X } from "lucide-react";

import type { Cell, DetectionCollection, DetectionProps } from "@/lib/types";
import type { RegionDef } from "@/lib/regions";
import {
  BASEMAPS,
  BASEMAP_MAP,
  GIBS_ATTRIBUTION,
  GIBS_RASTER_PAINT,
  MAP_COLORS,
  applyImageryDate,
  bboxPolygon,
  buildMapStyle,
  gibsTileTemplate,
} from "@/lib/map-style";
import type { BasemapMode } from "@/lib/map-style";
import { cn, formatInt, formatNum } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import { MapLegend } from "./MapLegend";
import { buildDetectionPopup } from "./popupContent";
import { bboxFromCorners, bboxLabel, intersectBbox, isMeaningfulAoi } from "./aoi";
import type { Bbox } from "./aoi";
import type { CellFeatureProps, ViewCommand, ViewPort } from "./types";

const CLUSTER_RADIUS = 44;
const MAX_POINTS = 20000;

const SENSOR_OUTLINE_COLOR: ExpressionSpecification = [
  "match",
  ["get", "sensor"],
  "modis",
  "#FF9D42",
  "viirs",
  "#FFD84D",
  MAP_COLORS.ink,
];

const DOMINANT_OUTLINE_COLOR: ExpressionSpecification = [
  "match",
  ["get", "dominant"],
  "modis", "#FF9D42",
  "viirs", "#FFD84D",
  "both", MAP_COLORS.ink,
  MAP_COLORS.ink,
];

const CLUSTER_COLOR = MAP_COLORS.fire;

/**
 * Cells are sized by detection count, then scaled by zoom so a 2° grid does not
 * collapse into an unreadable blob at world zoom.
 */
const CELL_COUNT_SIZE: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["sqrt", ["coalesce", ["get", "count"], 1]],
  1,
  3,
  4,
  5.2,
  10,
  7.6,
  25,
  11,
  60,
  15,
];

/**
 * Composite expression: MapLibre does not accept a plain product of a
 * data-driven and a zoom-driven expression, so zoom is the interpolate input
 * and the scaled count expression lives in its stops.
 */
const CELL_RADIUS: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  0,
  ["*", CELL_COUNT_SIZE, 0.2],
  2,
  ["*", CELL_COUNT_SIZE, 0.32],
  3.5,
  ["*", CELL_COUNT_SIZE, 0.55],
  5,
  ["*", CELL_COUNT_SIZE, 0.95],
  7,
  ["*", CELL_COUNT_SIZE, 1.25],
  10,
  ["*", CELL_COUNT_SIZE, 1.5],
];

const CELL_FILL_OPACITY: ExpressionSpecification = [
  "case",
  ["boolean", ["feature-state", "hover"], false],
  0.55,
  ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "count"], 1]], 1, 0.26, 4, 0.42, 12, 0.6, 40, 0.84],
];

const POINT_RADIUS: ExpressionSpecification = [  "interpolate",
  ["linear"],
  ["coalesce", ["get", "frp"], 0],
  0,
  2.6,
  5,
  3.6,
  20,
  5,
  75,
  7.5,
  250,
  11,
  800,
  16,
];

/** Slippy-map tile index for a lon/lat at a given zoom. */
function tileIndex(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const rad = (Math.min(Math.max(lat, -85), 85) * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

/**
 * GIBS answers 200 with a near-black placeholder for days it has not processed,
 * so a successful load is not proof of imagery. Sample the tile covering the
 * study region and require actual light in it before trusting the basemap.
 */
function tileHasImagery(layer: string, date: string, lng: number, lat: number): Promise<boolean> {
  const { x, y } = tileIndex(lng, lat, 5);
  const url = gibsTileTemplate(layer, date)
    .replace("{z}", "5")
    .replace("{y}", String(y))
    .replace("{x}", String(x));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), 9000);
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(true);
        ctx.drawImage(img, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);
        let lit = 0;
        let mean = 0;
        for (let i = 0; i < data.length; i += 4) {
          const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
          mean += l;
          if (l > 14) lit += 1;
        }
        const samples = data.length / 4;
        finish(mean / samples > 9 || lit / samples > 0.04);
      } catch {
        // Readback blocked: trust the tile rather than downgrade on a CORS quirk.
        finish(true);
      }
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

const POINT_OPACITY: ExpressionSpecification = [
  "match",
  ["get", "confidenceClass"],
  "high",
  0.95,
  "nominal",
  0.82,
  "low",
  0.6,
  0.75,
];

function emptyFC(): FeatureCollection<GeoPoint> {
  return { type: "FeatureCollection", features: [] };
}

function numProp(props: Record<string, unknown> | null, key: string): number | null {
  if (!props) return null;
  const v = props[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strProp(props: Record<string, unknown> | null, key: string, fallback = ""): string {
  if (!props) return fallback;
  const v = props[key];
  return typeof v === "string" ? v : fallback;
}

function dominantOf(modis: number, viirs: number): CellFeatureProps["dominant"] {
  const total = modis + viirs;
  if (total === 0) return "both";
  const minorityShare = Math.min(modis, viirs) / total;
  // "Both" is reserved for genuine co-detection; otherwise the majority sensor wins.
  if (minorityShare >= 0.3) return "both";
  return modis > viirs ? "modis" : "viirs";
}

function cellsToGeoJSON(cells: Cell[] | null): FeatureCollection<GeoPoint> {
  if (!cells || cells.length === 0) return emptyFC();
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        lat: c.lat,
        lon: c.lon,
        count: c.count,
        modis: c.modis,
        viirs: c.viirs,
        frp: c.frp,
        maxFrp: c.maxFrp,
        high: c.high,
        dominant: dominantOf(c.modis, c.viirs),
      } satisfies CellFeatureProps,
    })),
  };
}

/** DetectionCollection → plain GeoJSON (properties copied so they stay data-only). */
function detectionsToGeoJSON(collection: DetectionCollection | null): FeatureCollection<GeoPoint> {
  if (!collection || collection.features.length === 0) return emptyFC();
  const features: Feature<GeoPoint>[] = collection.features.slice(0, MAX_POINTS).map((f) => ({
    type: "Feature",
    geometry: f.geometry,
    properties: { ...f.properties },
  }));
  return { type: "FeatureCollection", features };
}

function featureToDetection(feature: Feature<GeoPoint>): DetectionProps | null {
  const props = (feature.properties ?? null) as Record<string, unknown> | null;
  const id = strProp(props, "id");
  const sensor = strProp(props, "sensor");
  const coords = feature.geometry.coordinates;
  if (!id || (sensor !== "modis" && sensor !== "viirs")) return null;
  const confidenceClass = strProp(props, "confidenceClass");
  const daynight = strProp(props, "daynight");
  return {
    id,
    sensor,
    instrument: strProp(props, "instrument", sensor.toUpperCase()),
    satellite: strProp(props, "satellite", "—"),
    acqDate: strProp(props, "acqDate"),
    acqTime: strProp(props, "acqTime"),
    ts: numProp(props, "ts") ?? 0,
    lat: numProp(props, "lat") ?? coords[1],
    lon: numProp(props, "lon") ?? coords[0],
    frp: numProp(props, "frp"),
    confidence: strProp(props, "confidence"),
    confidencePct: numProp(props, "confidencePct"),
    confidenceClass: confidenceClass === "high" || confidenceClass === "nominal" || confidenceClass === "low" ? confidenceClass : null,
    brightness: numProp(props, "brightness"),
    brightT31: numProp(props, "brightT31"),
    scan: numProp(props, "scan"),
    track: numProp(props, "track"),
    daynight: daynight === "D" || daynight === "N" ? daynight : null,
    version: strProp(props, "version"),
    source: strProp(props, "source"),
  };
}

interface HoverState {
  x: number;
  y: number;
  lat: number;
  lon: number;
  count: number;
  modis: number;
  viirs: number;
  maxFrp: number;
}

export interface MapCanvasProps {
  region: RegionDef;
  mode: "cells" | "points";
  cells: Cell[] | null;
  detections: DetectionCollection | null;
  basemap: BasemapMode;
  imageryDate: string;
  loading: boolean;
  analyzeArmed: boolean;
  /** Rectangle tool: drag on the map to define the area of interest. */
  aoiArmed: boolean;
  /** Committed AOI rectangle, clipped to the study region. */
  aoi: Bbox | null;
  expanded: boolean;
  selectedId: string | null;
  command: ViewCommand | null;
  freshDate: string | null;
  onViewChange: (view: ViewPort) => void;
  onBasemapChange: (mode: BasemapMode) => void;
  onSelect: (detection: DetectionProps | null) => void;
  onPick: (lat: number, lon: number) => void;
  onAoiChange: (bbox: Bbox | null) => void;
  onToggleAoi: () => void;
  onAskFocused: () => void;
  onToggleAnalyze: () => void;
  onToggleExpand: () => void;
}

export function MapCanvas(props: MapCanvasProps) {
  const {
    region,
    mode,
    cells,
    detections,
    basemap,
    imageryDate,
    loading,
    analyzeArmed,
    aoiArmed,
    aoi,
    expanded,
    selectedId,
    command,
    freshDate,
    onViewChange,
    onBasemapChange,
    onSelect,
    onPick,
    onAoiChange,
    onToggleAoi,
    onAskFocused,
    onToggleAnalyze,
    onToggleExpand,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<MapLibrePopup | null>(null);
  const hoveredCellId = useRef<string | number | null>(null);
  const hoverRaf = useRef<number | null>(null);
  const pendingHover = useRef<HoverState | null>(null);
  const imageryFailures = useRef(0);
  const fallbackTried = useRef(false);

  const [ready, setReady] = useState(false);
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [zoom, setZoom] = useState(1.5);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [imageryNotice, setImageryNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Bbox | null>(null);

  // Rectangle-drag bookkeeping. `moved` suppresses the click that follows a drag.
  const dragRef = useRef<{ start: [number, number] | null; moved: boolean }>({ start: null, moved: false });

  // Latest callbacks/state for imperative map handlers.
  const live = useRef({ ...props });
  live.current = props;

  const cellsGeoJSON = useMemo(() => cellsToGeoJSON(cells), [cells]);
  const detectionsGeoJSON = useMemo(() => detectionsToGeoJSON(detections), [detections]);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const emitView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const z = map.getZoom();
    setZoom(z);
    live.current.onViewChange({
      zoom: z,
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    });
  }, []);

  const pushHover = useCallback((next: HoverState | null) => {
    pendingHover.current = next;
    if (hoverRaf.current !== null) return;
    hoverRaf.current = window.requestAnimationFrame(() => {
      hoverRaf.current = null;
      setHover(pendingHover.current);
    });
  }, []);

  /* ------------------------------------------------------------------ */
  /* Map lifecycle                                                       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialBasemap: BasemapMode = basemap === "clean" ? "viirs" : basemap;
    const map = new MapLibreMapClass({
      container,
      style: buildMapStyle(initialBasemap, imageryDate),
      center: [0, 18],
      zoom: 1.4,
      minZoom: 0.35,
      maxZoom: 11,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });
    mapRef.current = map;
    setCanvasVisible(true);
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __firewatchMap?: MapLibreMap }).__firewatchMap = map;
    }

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new FullscreenControl(), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 92, unit: "metric" }), "bottom-right");

    if (basemap === "clean") {
      // Style was built with imagery so the raster source exists for later mode
      // switches — hide it for the clean mode.
      map.once("style.load", () => {
        if (map.getLayer("gibs-raster")) map.setLayoutProperty("gibs-raster", "visibility", "none");
        if (map.getLayer("imagery-scrim")) map.setLayoutProperty("imagery-scrim", "visibility", "none");
      });
    }

    const setCursor = (value: string) => {
      map.getCanvas().style.cursor = value;
    };

    map.on("error", (event) => {
      const sourceId = (event as unknown as { sourceId?: string }).sourceId;
      if (sourceId !== "gibs") return;
      imageryFailures.current += 1;
      if (imageryFailures.current < 6 || fallbackTried.current) return;
      fallbackTried.current = true;
      const current = live.current;
      if (current.basemap === "viirs") {
        current.onBasemapChange("modis");
        setImageryNotice("VIIRS true colour unavailable for this date — switched to MODIS Terra.");
      } else {
        setImageryNotice("NASA GIBS imagery unavailable — showing the dark graticule only.");
      }
    });

    map.once("style.load", () => {
      setReady(true);
      const regionBox = live.current.region.bbox;

      map.addSource("region", { type: "geojson", data: bboxPolygon(regionBox) });
      map.addLayer({
        id: "region-fill",
        type: "fill",
        source: "region",
        paint: { "fill-color": MAP_COLORS.modis, "fill-opacity": 0.035 },
      });
      map.addLayer({
        id: "region-line",
        type: "line",
        source: "region",
        paint: {
          "line-color": MAP_COLORS.modis,
          "line-opacity": 0.5,
          "line-width": 1,
          "line-dasharray": [3, 3],
        },
      });

      /* Area of interest: a user-drawn rectangle, clipped to the study region. */
      map.addSource("aoi", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "aoi-fill",
        type: "fill",
        source: "aoi",
        paint: { "fill-color": MAP_COLORS.modis, "fill-opacity": 0.07 },
      });
      map.addLayer({
        id: "aoi-line",
        type: "line",
        source: "aoi",
        paint: {
          "line-color": MAP_COLORS.modis,
          "line-opacity": 0.95,
          "line-width": 1.4,
          "line-dasharray": [5, 3],
        },
      });

      map.addSource("cells", { type: "geojson", data: emptyFC(), generateId: true });
      map.addLayer({
        id: "cells-halo",
        type: "circle",
        source: "cells",
        paint: {
          "circle-radius": CELL_RADIUS,
          "circle-color": MAP_COLORS.fire,
          "circle-opacity": 0.1,
          "circle-blur": 1,
        },
      });
      map.addLayer({
        id: "cells-fill",
        type: "circle",
        source: "cells",
        paint: {
          "circle-radius": CELL_RADIUS,
          "circle-color": MAP_COLORS.fire,
          "circle-opacity": CELL_FILL_OPACITY,
          "circle-stroke-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            MAP_COLORS.ink,
            DOMINANT_OUTLINE_COLOR,
          ],
          "circle-stroke-width": ["case", ["boolean", ["feature-state", "hover"], false], 1.2, 0.5],
        },
      });

      map.addSource("dets", {
        type: "geojson",
        data: emptyFC(),
        cluster: true,
        clusterRadius: CLUSTER_RADIUS,
        clusterMaxZoom: 10,
        generateId: true,
      });
      map.addLayer({
        id: "dets-clusters-halo",
        type: "circle",
        source: "dets",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 50, 20, 250, 24, 1000, 28, 5000, 33],
          "circle-color": CLUSTER_COLOR,
          "circle-opacity": 0.09,
          "circle-blur": 1,
        },
      });
      map.addLayer({
        id: "dets-clusters",
        type: "circle",
        source: "dets",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 7, 10, 10, 50, 13, 250, 16, 1000, 20, 5000, 24],
          "circle-color": CLUSTER_COLOR,
          "circle-opacity": 0.22,
          "circle-stroke-color": CLUSTER_COLOR,
          "circle-stroke-opacity": 0.95,
          "circle-stroke-width": 1.3,
        },
      });
      map.addLayer({
        id: "dets-cluster-count",
        type: "symbol",
        source: "dets",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Open Sans Semibold"],
          "text-size": ["step", ["get", "point_count"], 10, 100, 11, 1000, 12],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": MAP_COLORS.ink,
          "text-halo-color": "rgba(5,8,15,0.85)",
          "text-halo-width": 1.2,
        },
      });
      map.addLayer({
        id: "dets-glow",
        type: "circle",
        source: "dets",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": POINT_RADIUS,
          "circle-color": MAP_COLORS.fire,
          "circle-opacity": 0.14,
          "circle-blur": 1,
        },
      });
      map.addLayer({
        id: "dets-point",
        type: "circle",
        source: "dets",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": POINT_RADIUS,
          "circle-color": MAP_COLORS.fire,
          "circle-opacity": POINT_OPACITY,
          "circle-stroke-color": SENSOR_OUTLINE_COLOR,
          "circle-stroke-width": 1.1,
        },
      });
      map.addLayer({
        id: "dets-selected",
        type: "circle",
        source: "dets",
        filter: ["==", ["get", "id"], "__none__"],
        paint: {
          "circle-radius": 13,
          "circle-color": "rgba(241,245,252,0.06)",
          "circle-stroke-color": MAP_COLORS.ink,
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0.9,
        },
      });

      /* ------------------------- interactions ------------------------- */
      map.on("moveend", emitView);

      /* ---- area-of-interest rectangle (drag) ---- */
      const paintAoi = (bbox: Bbox | null) => {
        const src = map.getSource("aoi") as GeoJSONSource | undefined;
        src?.setData(bbox ? bboxPolygon(bbox) : emptyFC());
        setDraft(bbox);
      };

      map.on("mousedown", (event: MapMouseEvent) => {
        if (!live.current.aoiArmed) return;
        dragRef.current = { start: [event.lngLat.lng, event.lngLat.lat], moved: false };
      });

      map.on("mousemove", (event: MapMouseEvent) => {
        const start = dragRef.current.start;
        if (!live.current.aoiArmed || !start) return;
        dragRef.current.moved = true;
        const raw = bboxFromCorners(start, [event.lngLat.lng, event.lngLat.lat]);
        paintAoi(intersectBbox(raw, live.current.region.bbox));
      });

      map.on("mouseup", (event: MapMouseEvent) => {
        const start = dragRef.current.start;
        if (!live.current.aoiArmed || !start) return;
        dragRef.current.start = null;
        const raw = bboxFromCorners(start, [event.lngLat.lng, event.lngLat.lat]);
        const clipped = intersectBbox(raw, live.current.region.bbox);
        if (!clipped || !isMeaningfulAoi(clipped)) {
          // A click, not a rectangle: keep whatever was committed before.
          paintAoi(live.current.aoi);
          return;
        }
        paintAoi(clipped);
        live.current.onAoiChange(clipped);
      });

      map.on("click", (event: MapMouseEvent) => {
        const current = live.current;
        if (current.aoiArmed) return;
        if (dragRef.current.moved) {
          dragRef.current.moved = false;
          return;
        }
        if (current.analyzeArmed) {
          current.onPick(event.lngLat.lat, event.lngLat.lng);
          return;
        }
        if (current.mode === "points") {
          const queryLayers = ["dets-clusters", "dets-point"].filter((id) => map.getLayer(id));
          if (queryLayers.length > 0) {
            const features = map.queryRenderedFeatures(event.point, { layers: queryLayers });
            const feature = features[0];
            if (feature) {
              const props = (feature.properties ?? null) as Record<string, unknown> | null;
              const clusterId = numProp(props, "cluster_id");
              if (feature.layer.id === "dets-clusters" && clusterId !== null) {
                const source = map.getSource("dets") as GeoJSONSource | undefined;
                source
                  ?.getClusterExpansionZoom(clusterId)
                  .then((nextZoom) => {
                    map.easeTo({
                      center: event.lngLat,
                      zoom: Math.min(nextZoom + 0.15, 11),
                      duration: 420,
                    });
                  })
                  .catch(() => undefined);
                return;
              }
              const detection = featureToDetection(feature as unknown as Feature<GeoPoint>);
              if (detection) {
                current.onSelect(detection);
                popupRef.current?.remove();
                const el = buildDetectionPopup(detection, () => {
                  live.current.onAskFocused();
                  popupRef.current?.remove();
                });
                popupRef.current = new MapLibrePopup({
                  closeButton: true,
                  closeOnClick: false,
                  maxWidth: "296px",
                  offset: 13,
                })
                  .setLngLat([detection.lon, detection.lat])
                  .setDOMContent(el)
                  .addTo(map);
                return;
              }
            }
          }
        }
        current.onSelect(null);
        popupRef.current?.remove();
        popupRef.current = null;
      });

      map.on("contextmenu", (event: MapMouseEvent) => {
        event.preventDefault();
        live.current.onPick(event.lngLat.lat, event.lngLat.lng);
      });

      map.on("mousemove", "cells-fill", (event) => {
        if (live.current.analyzeArmed) {
          setCursor("crosshair");
        } else {
          setCursor("pointer");
        }
        const feature = event.features?.[0];
        if (!feature) return;
        const props = (feature.properties ?? null) as Record<string, unknown> | null;
        const id = feature.id ?? null;
        if (hoveredCellId.current !== id) {
          if (hoveredCellId.current !== null) {
            map.setFeatureState({ source: "cells", id: hoveredCellId.current }, { hover: false });
          }
          hoveredCellId.current = id;
          if (id !== null) map.setFeatureState({ source: "cells", id }, { hover: true });
        }
        pushHover({
          x: event.point.x,
          y: event.point.y,
          lat: numProp(props, "lat") ?? 0,
          lon: numProp(props, "lon") ?? 0,
          count: numProp(props, "count") ?? 0,
          modis: numProp(props, "modis") ?? 0,
          viirs: numProp(props, "viirs") ?? 0,
          maxFrp: numProp(props, "maxFrp") ?? 0,
        });
      });

      map.on("mouseleave", "cells-fill", () => {
        if (hoveredCellId.current !== null) {
          map.setFeatureState({ source: "cells", id: hoveredCellId.current }, { hover: false });
          hoveredCellId.current = null;
        }
        setCursor(live.current.analyzeArmed ? "crosshair" : "");
        pushHover(null);
      });

      map.on("mousemove", "dets-point", () => {
        setCursor(live.current.analyzeArmed ? "crosshair" : "pointer");
      });
      map.on("mouseleave", "dets-point", () => {
        setCursor(live.current.analyzeArmed ? "crosshair" : "");
      });
      map.on("mousemove", "dets-clusters", () => {
        setCursor(live.current.analyzeArmed ? "crosshair" : "pointer");
      });
      map.on("mouseleave", "dets-clusters", () => {
        setCursor(live.current.analyzeArmed ? "crosshair" : "");
      });

      map.resize();
      const [w, s, e, n] = regionBox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 26, duration: 0, maxZoom: 6.4 },
      );
      emitView();
    });

    return () => {
      if (hoverRaf.current !== null) window.cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
      setCanvasVisible(false);
      imageryFailures.current = 0;
      fallbackTried.current = false;
    };
    // Intentionally mount-once: subsequent changes are handled by dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Region change → refit and move the study-area outline. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const [w, s, e, n] = region.bbox;
    const source = map.getSource("region") as GeoJSONSource | undefined;
    source?.setData(bboxPolygon(region.bbox));
    map.resize();
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 26, duration: 550, maxZoom: 6.4 },
    );
    popupRef.current?.remove();
    popupRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region.id, ready]);

  /* Validate the requested GIBS layer/date against the region itself: GIBS 404s
     for unprocessed days and returns placeholder tiles for partly processed
     ones, and both cases leave the map black over the study area. */
  useEffect(() => {
    if (!ready || !imageryDate) return;
    const meta = BASEMAP_MAP[basemap];
    if (!meta.layer) {
      setImageryNotice(null);
      return;
    }
    let alive = true;
    const [west, south, east, north] = region.bbox;
    tileHasImagery(meta.layer, imageryDate, (west + east) / 2, (south + north) / 2).then((ok) => {
      if (!alive) return;
      if (ok) {
        setImageryNotice(null);
        return;
      }
      if (basemap === "viirs") {
        onBasemapChange("modis");
        setImageryNotice(
          `VIIRS true colour is not processed for ${imageryDate} over ${region.name} — switched to MODIS Terra.`,
        );
      } else {
        setImageryNotice(`NASA GIBS has no true-colour composite for ${imageryDate} here — dark graticule only.`);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, basemap, imageryDate, region.id]);

  /* Imagery mode + date. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const meta = BASEMAP_MAP[basemap];
    const show = meta.layer ? "visible" : "none";
    if (map.getLayer("gibs-raster")) map.setLayoutProperty("gibs-raster", "visibility", show);
    if (map.getLayer("imagery-scrim")) map.setLayoutProperty("imagery-scrim", "visibility", show);
    if (map.getLayer("graticule-minor")) {
      map.setPaintProperty("graticule-minor", "line-opacity", basemap === "clean" ? 0.13 : 0.08);
    }
    if (map.getLayer("graticule-major")) {
      map.setPaintProperty("graticule-major", "line-opacity", basemap === "clean" ? 0.26 : 0.16);
    }
    if (meta.layer) {
      if (!map.getSource("gibs") && imageryDate) {
        map.addSource("gibs", {
          type: "raster",
          tiles: [gibsTileTemplate(meta.layer, imageryDate)],
          tileSize: 256,
          maxzoom: 9,
          attribution: GIBS_ATTRIBUTION,
        });
        if (!map.getLayer("gibs-raster")) {
          map.addLayer(
            { id: "gibs-raster", type: "raster", source: "gibs", paint: GIBS_RASTER_PAINT },
            "graticule-minor",
          );
        }
        if (!map.getLayer("imagery-scrim")) {
          map.addLayer(
            {
              id: "imagery-scrim",
              type: "background",
              paint: { "background-color": MAP_COLORS.void, "background-opacity": 0.16 },
            },
            "graticule-minor",
          );
        }
      }
      if (imageryDate) applyImageryDate(map, meta.layer, imageryDate);
      imageryFailures.current = 0;
      fallbackTried.current = false;
      setImageryNotice(null);
    }
  }, [basemap, imageryDate, ready]);

  /* Source data updates — setData only, never re-adding layers. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("cells") as GeoJSONSource | undefined;
    source?.setData(mode === "cells" ? cellsGeoJSON : emptyFC());
  }, [cellsGeoJSON, mode, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("dets") as GeoJSONSource | undefined;
    source?.setData(mode === "points" ? detectionsGeoJSON : emptyFC());
    if (mode === "cells") {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [detectionsGeoJSON, mode, ready]);

  /* Selection highlight + popup teardown. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter("dets-selected", ["==", ["get", "id"], selectedId ?? "__none__"]);
    if (!selectedId) {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [selectedId, ready]);

  /* AOI rectangle: mirror the committed extent into the map source. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("aoi") as GeoJSONSource | undefined;
    src?.setData(aoi ? bboxPolygon(aoi) : emptyFC());
    setDraft(aoi);
  }, [aoi, ready]);

  /* Rectangle tool on/off: dragging the map would fight the rectangle drag. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (aoiArmed) {
      map.dragPan.disable();
      map.boxZoom.disable();
      map.getCanvas().style.cursor = "crosshair";
      popupRef.current?.remove();
      popupRef.current = null;
    } else {
      map.dragPan.enable();
      map.boxZoom.enable();
      map.getCanvas().style.cursor = analyzeArmed ? "crosshair" : "";
      dragRef.current.start = null;
    }
  }, [aoiArmed, analyzeArmed, ready]);

  /* Analyze-arm cursor. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = analyzeArmed ? "crosshair" : "";
    if (analyzeArmed) {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [analyzeArmed, ready]);

  /* Imperative view commands (reset / fly-to). */
  const commandNonce = command?.nonce ?? 0;
  useEffect(() => {
    const map = mapRef.current;
    const cmd = command;
    if (!map || !ready || !cmd) return;
    if (cmd.kind === "reset") {
      const [w, s, e, n] = region.bbox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 26, duration: 550, maxZoom: 6.4 },
      );
      return;
    }
    if (cmd.kind === "bbox") {
      const [w, s, e, n] = cmd.bbox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 46, duration: prefersReducedMotion() ? 0 : 620, maxZoom: 9 },
      );
      return;
    }
    map.easeTo({
      center: [cmd.lon, cmd.lat],
      zoom: cmd.zoom ?? Math.max(map.getZoom(), 6.5),
      duration: 700,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandNonce, ready]);

  /* Container resize (expand toggle). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const timers = [180, 320, 520].map((ms) => window.setTimeout(() => map.resize(), ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [expanded]);

  const confine = useCallback((event: React.SyntheticEvent) => event.preventDefault(), []);

  return (
    <div className="absolute inset-0" onContextMenu={confine}>
      <div ref={containerRef} className="h-full w-full" />

      {/* vignette + hairline frame */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ boxShadow: "inset 0 0 140px 24px rgba(5,8,15,0.6)" }}
      />

      {/* toolbar */}
      <div className="pointer-events-none absolute left-2.5 top-2.5 z-20 flex flex-col gap-2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line/80 bg-panel/90 p-1 shadow-panel backdrop-blur-md">
          {BASEMAPS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onBasemapChange(option.id)}
              aria-pressed={basemap === option.id}
              title={option.label}
              className={cn(
                "rounded px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors",
                basemap === option.id ? "bg-cyan/15 text-cyan" : "text-muted/70 hover:bg-elevated/60 hover:text-ink",
              )}
            >
              {option.short}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line/70" />
          <button
            type="button"
            onClick={onToggleAnalyze}
            aria-pressed={analyzeArmed}
            title="Analyze this point (A)"
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors",
              analyzeArmed ? "bg-cyan/20 text-cyan" : "text-muted/70 hover:bg-elevated/60 hover:text-ink",
            )}
          >
            <Crosshair size={11} />
            Analyze
          </button>
          <button
            type="button"
            onClick={onToggleAoi}
            aria-pressed={aoiArmed}
            title="Draw an area of interest (drag a rectangle)"
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors",
              aoiArmed ? "bg-cyan/20 text-cyan" : "text-muted/70 hover:bg-elevated/60 hover:text-ink",
            )}
          >
            <SquareDashed size={11} />
            AOI
          </button>
          <button
            type="button"
            onClick={() => {
              const map = mapRef.current;
              if (!map) return;
              const [w, s, e, n] = region.bbox;
              map.fitBounds(
                [
                  [w, s],
                  [e, n],
                ],
                { padding: 26, duration: 550, maxZoom: 6.4 },
              );
            }}
            title="Reset view to region"
            aria-label="Reset view to study region"
            className="rounded p-1 text-muted/70 transition-colors hover:bg-elevated/60 hover:text-ink"
          >
            <LocateFixed size={12} />
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            title={expanded ? "Collapse map" : "Expand map"}
            aria-label={expanded ? "Collapse map" : "Expand map"}
            className="rounded p-1 text-muted/70 transition-colors hover:bg-elevated/60 hover:text-ink"
          >
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      {/* region + zoom readout, tucked under the zoom buttons */}
      <div className="pointer-events-none absolute right-2.5 top-[86px] z-20 hidden flex-col items-end gap-1 sm:flex">
        <div className="inline-flex w-fit items-center gap-1.5 rounded-md border border-line/60 bg-panel/80 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink/85 backdrop-blur-md">
          <span className={cn("text-cyan/90", loading && "animate-pulse")}>z {zoom.toFixed(1)}</span>
          <span className="text-line">/</span>
          <span className="text-muted/80">{mode === "cells" ? "grid" : "clustered"}</span>
        </div>
      </div>

      {imageryNotice ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-md border border-ember/30 bg-panel/90 px-2.5 py-1 text-[10px] text-ember/90 backdrop-blur-md">
          {imageryNotice}
        </div>
      ) : null}

      {analyzeArmed ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan/40 bg-panel/95 px-3 py-1.5 text-[10.5px] text-cyan shadow-glow backdrop-blur-md">
          <MousePointerClick size={12} />
          Click the map to analyze · <span className="font-mono">Esc</span> to cancel
        </div>
      ) : null}

      {aoiArmed ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan/40 bg-panel/95 px-3 py-1.5 text-[10.5px] text-cyan shadow-glow backdrop-blur-md">
          <SquareDashed size={12} />
          {dragRef.current.start ? "Release to apply the rectangle" : "Drag a rectangle to define the area of interest"}
          {draft ? <span className="font-mono text-[9.5px] text-cyan/80">{bboxLabel(draft)}</span> : null}
          <span className="font-mono">Esc</span> to cancel
        </div>
      ) : null}

      {aoi && !aoiArmed ? (
        <div className="absolute left-2.5 top-[46px] z-20 flex max-w-[240px] items-center gap-1.5 rounded-md border border-cyan/30 bg-panel/92 px-2 py-1 shadow-panel backdrop-blur-md">
          <SquareDashed size={11} className="shrink-0 text-cyan" />
          <span className="min-w-0 truncate font-mono text-[9.5px] text-ink/85">{bboxLabel(aoi)}</span>
          <button
            type="button"
            onClick={() => onAoiChange(null)}
            title="Clear the area of interest"
            aria-label="Clear the area of interest"
            className="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-ink"
          >
            <X size={10} />
          </button>
        </div>
      ) : null}

      {/* cell hover tooltip */}
      {hover ? (
        <div
          className="pointer-events-none absolute z-30 w-[168px] rounded-md border border-line/80 bg-panel/95 px-2.5 py-2 shadow-panel backdrop-blur-md"
          style={{ left: Math.min(hover.x + 14, 100000), top: hover.y + 14 }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="value text-[14px]">{formatInt(hover.count)}</span>
            <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted/70">detections</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[9px]">
            <span className="text-cyan">MODIS {formatInt(hover.modis)}</span>
            <span className="text-ember">VIIRS {formatInt(hover.viirs)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-muted/70">
            <span>max FRP</span>
            <span className="text-ink/85">{formatNum(hover.maxFrp, 1)} MW</span>
          </div>
          <p className="mt-1 font-mono text-[8.5px] text-muted/50">
            {hover.lat.toFixed(1)}, {hover.lon.toFixed(1)} · aggregated cell
          </p>
        </div>
      ) : null}

      <MapLegend mode={mode} freshDate={freshDate} className="absolute bottom-3 left-3 z-20 hidden sm:block" />

      {!canvasVisible ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-void">
          <div className="flex flex-col items-center gap-2">
            <span className="h-6 w-6 animate-spin rounded-full border border-line border-t-cyan" />
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted/70">Initialising map</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
