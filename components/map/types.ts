import type { Cell, DetectionProps } from "@/lib/types";
import type { BasemapMode } from "@/lib/map-style";

export type SensorFilter = "both" | "modis" | "viirs";
export type DayNightFilter = "" | "D" | "N";
export type ConfidenceClass = "low" | "nominal" | "high";

export interface MapFilterState {
  sensor: SensorFilter;
  confidence: ConfidenceClass[];
  minFrp: number;
  daynight: DayNightFilter;
  satellites: string[];
  start: string;
  end: string;
}

/** Aggregates over the full study region, summed from the /api/cells grid. */
export interface RegionTotals {
  total: number;
  modis: number;
  viirs: number;
  high: number;
  frpSum: number;
  maxFrp: number;
  cells: number;
}

/** Response of GET /api/cells (lib/types.ts only declares the Cell shape). */
export interface CellsResponse {
  cell: number;
  cells: Cell[];
  total?: number;
}

export interface EngagementPoint {
  lat: number;
  lon: number;
  obsId: string | null;
}

export interface SelectedDetection extends DetectionProps {
  /** Human-readable dataset label resolved from the engine payload. */
  dataset: string;
}

export interface ViewPort {
  zoom: number;
  bbox: [number, number, number, number];
}

export type ViewCommand =
  | { kind: "reset"; nonce: number }
  | { kind: "focus"; nonce: number; lat: number; lon: number; zoom?: number }
  | { kind: "bbox"; nonce: number; bbox: [number, number, number, number] };

export interface CellFeatureProps {
  lat: number;
  lon: number;
  count: number;
  modis: number;
  viirs: number;
  frp: number;
  maxFrp: number;
  high: number;
  dominant: "modis" | "viirs" | "both";
}

export interface LayerModeMeta {
  basemap: BasemapMode;
  label: string;
}

export const CONFIDENCE_OPTIONS: { value: ConfidenceClass; label: string }[] = [
  { value: "high", label: "High" },
  { value: "nominal", label: "Nominal" },
  { value: "low", label: "Low" },
];

export const SATELLITE_OPTIONS = [
  { value: "Terra", label: "MODIS Terra", sensor: "MODIS" },
  { value: "Aqua", label: "MODIS Aqua", sensor: "MODIS" },
  { value: "Suomi-NPP", label: "VIIRS Suomi-NPP", sensor: "VIIRS" },
  { value: "NOAA-20", label: "VIIRS NOAA-20", sensor: "VIIRS" },
  { value: "NOAA-21", label: "VIIRS NOAA-21", sensor: "VIIRS" },
] as const;
