import type { Map as MapLibreMap, RasterTileSource, StyleSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Polygon } from "geojson";

/** Basemap modes offered by the layer switcher. */
export type BasemapMode = "satellite" | "viirs" | "modis" | "clean";

export interface BasemapMeta {
  id: BasemapMode;
  label: string;
  short: string;
  /** GIBS layer name, or null for the imagery-free mode. */
  layer: string | null;
  note: string;
}

export const GIBS_ATTRIBUTION = "NASA EOSDIS GIBS / World Imagery";
const ESRI_ATTRIBUTION = "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

export const BASEMAPS: BasemapMeta[] = [
  {
    id: "satellite",
    label: "Satellite reference",
    short: "SAT",
    layer: null,
    note: "Esri World Imagery mosaic; date unspecified. Public tiles, no API key required.",
  },
  {
    id: "viirs",
    label: "VIIRS true colour",
    short: "VIIRS",
    layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    note: "Suomi NPP corrected reflectance, 250 m, daily composite.",
  },
  {
    id: "modis",
    label: "MODIS Terra true colour",
    short: "MODIS",
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    note: "Terra corrected reflectance, 250 m, daily composite.",
  },
  {
    id: "clean",
    label: "Dark labels",
    short: "CLEAN",
    layer: null,
    note: "Satellite imagery off; labelled dark map and graticule remain visible.",
  },
];

export const BASEMAP_MAP: Record<BasemapMode, BasemapMeta> = Object.fromEntries(
  BASEMAPS.map((b) => [b.id, b]),
) as Record<BasemapMode, BasemapMeta>;

/** NASA GIBS WMTS raster template (EPSG:3857, GoogleMapsCompatible_Level9). */
export function gibsTileTemplate(layer: string, date: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

export const MAP_COLORS = {
  void: "#05080f",
  grid: "#39c8f2",
  modis: "#39C8F2",
  viirs: "#FF9D42",
  both: "#B9A4FF",
  fire: "#FF633D",
  ink: "#F1F5FC",
  line: "#22304A",
} as const;

const FONT_STACK = ["Open Sans Semibold"];

/** Raster paint tuned so imagery reads as instrument output over the dark ground. */
export const GIBS_RASTER_PAINT = {
  "raster-opacity": 0.5,
  "raster-saturation": -0.6,
  "raster-contrast": 0.16,
  "raster-brightness-min": 0.0,
  "raster-brightness-max": 0.42,
  "raster-fade-duration": 180,
} as const;

/** Shared style skeleton: dark ground, optional GIBS raster, graticule. */
export function buildMapStyle(mode: BasemapMode, imageryDate: string): StyleSpecification {
  const meta = BASEMAP_MAP[mode];
  const style: StyleSpecification = {
    version: 8,
    glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    sources: {
      reference: {
        type: "raster",
        tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 20,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
      graticule: {
        type: "geojson",
        data: graticuleGeoJSON(),
      },
    },
    layers: [
      {
        id: "ground",
        type: "background",
        paint: { "background-color": MAP_COLORS.void },
      },
      {
        id: "reference-raster",
        type: "raster",
        source: "reference",
        paint: { "raster-opacity": 1, "raster-fade-duration": 120 },
      },
    ],
  };

  if (mode === "satellite") {
    style.sources.satellite = {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: ESRI_ATTRIBUTION,
    };
    style.layers.push({
      id: "satellite-raster",
      type: "raster",
      source: "satellite",
      paint: { "raster-opacity": 1, "raster-fade-duration": 180 },
    });
  }

  if (meta.layer && imageryDate) {
    style.sources.gibs = {
      type: "raster",
      tiles: [gibsTileTemplate(meta.layer, imageryDate)],
      tileSize: 256,
      maxzoom: 9,
      attribution: GIBS_ATTRIBUTION,
    };
    style.layers.push({
      id: "gibs-raster",
      type: "raster",
      source: "gibs",
      paint: GIBS_RASTER_PAINT,
    });
    // Unifying scrim so imagery reads as instrument output, not a photo.
    style.layers.push({
      id: "imagery-scrim",
      type: "background",
      paint: { "background-color": MAP_COLORS.void, "background-opacity": 0.5 },
    });
  }

  style.layers.push(
    {
      id: "graticule-minor",
      type: "line",
      source: "graticule",
      filter: ["==", ["get", "major"], 0],
      paint: {
        "line-color": MAP_COLORS.grid,
        "line-opacity": mode === "clean" ? 0.13 : 0.08,
        "line-width": 0.6,
      },
    },
    {
      id: "graticule-major",
      type: "line",
      source: "graticule",
      filter: ["==", ["get", "major"], 1],
      paint: {
        "line-color": MAP_COLORS.grid,
        "line-opacity": mode === "clean" ? 0.26 : 0.16,
        "line-width": 0.9,
      },
    },
  );

  return style;
}

/** Apply a GIBS date to an existing raster source without rebuilding the style. */
export function applyImageryDate(map: MapLibreMap, layerName: string, date: string): void {
  const source = map.getSource("gibs") as RasterTileSource | undefined;
  if (source && typeof source.setTiles === "function") {
    source.setTiles([gibsTileTemplate(layerName, date)]);
  }
}

let cachedGraticule: FeatureCollection<LineString, { major: number }> | null = null;

/** 30° meridian / 15° parallel graticule in a single, memoised FeatureCollection. */
export function graticuleGeoJSON(): FeatureCollection<LineString, { major: number }> {
  if (cachedGraticule) return cachedGraticule;
  const features: Feature<LineString, { major: number }>[] = [];
  for (let lon = -180; lon <= 180; lon += 30) {
    const coords: [number, number][] = [];
    for (let lat = -78; lat <= 84; lat += 6) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: { major: lon === 0 ? 1 : 0 },
    });
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const coords: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 6) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: { major: lat === 0 ? 1 : 0 },
    });
  }
  cachedGraticule = { type: "FeatureCollection", features };
  return cachedGraticule;
}

/** Rectangle outline for the active study region. */
export function bboxPolygon(bbox: [number, number, number, number]): FeatureCollection<Polygon> {
  const [w, s, e, n] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
    ],
  };
}

export const FONT_FOR_CLUSTERS = FONT_STACK;

export function formatBbox(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  const fmt = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "N" : "S"}`;
  const fmtLon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "E" : "W"}`;
  return `${fmtLon(w)} → ${fmtLon(e)} · ${fmt(s)} → ${fmt(n)}`;
}
