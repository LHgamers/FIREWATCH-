export type Sensor = "modis" | "viirs";

export interface FrpStats {
  count: number;
  sum: number | null;
  mean: number | null;
  median: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface SensorSummary {
  detections: number;
  days: string[];
  nights: number;
  dayDetections: number;
  frp: FrpStats;
  satellites: Record<string, number>;
  confidence: { low: number; nominal: number; high: number; unclassified: number };
}

export interface Summary {
  bbox: [number, number, number, number];
  start: string | null;
  end: string | null;
  areaKm2: number;
  totalDetections: number;
  sensors: Record<Sensor, SensorSummary>;
  frpSum: number;
  dataDays: string[];
  region?: string;
  aoi?: Record<string, unknown>;
  coverage?: Coverage;
}

export interface Coverage {
  sensors: Record<string, { detections: number; firstDay: string; lastDay: string; days: number; ingestedAt: number }>;
  days: string[];
  first: string | null;
  last: string | null;
  sensorDays?: Record<string, number>;
  archiveEnabled?: boolean;
  archiveNote?: string;
  deliveryMethod?: string;
}

/**
 * The engine publishes five day/sensor states. `unknown` and `unavailable` are
 * different: `unknown` means no delivery evidence exists for that day, while
 * `unavailable` means the product was known to be down. Neither is zero.
 */
export type ObservationState = "observed" | "observed_zero" | "partial" | "unknown" | "unavailable";

export interface SensorDayState {
  state: ObservationState;
  code?: string;
  basis?: string;
  /** Null when the sensor-day has no delivery evidence (missing is not zero). */
  count: number | null;
  evidence: string;
  satellites?: Record<string, number>;
  frp?: number;
  stateLabel?: string;
  detections?: number;
}

export interface TimeseriesPoint {
  date: string;
  /** Null (not 0) when the day has neither detections nor delivery evidence. */
  modis: number | null;
  viirs: number | null;
  modisFrp: number | null;
  viirsFrp: number | null;
  total: number | null;
  available: boolean;
  state?: ObservationState;
  dataDays: number;
}

export interface DerivedBlock {
  activeCells: number;
  activeAreaKm2: number;
  frpSumMw: number;
  density: number | null;
  densityCi95: [number, number] | null;
  reduction?: string;
}

export interface DerivedDay {
  date: string;
  grid: number;
  modis?: DerivedBlock;
  viirs?: DerivedBlock;
  combined: DerivedBlock;
}

export interface YearBucket {
  year: number;
  buckets: { key: string; label: string; start: string; end: string; detections: number; frp: number }[];
  deliveryDays: number;
  observedDays: number;
  detections: number;
  frp: number;
  available: boolean;
  state: ObservationState;
}

export interface YearComparison {
  period: CalendarPeriod;
  years: YearBucket[];
  availableYears: number[];
  comparisonAvailable: boolean;
  comparisons: {
    bucket: string; label: string; earlyYear: number; lateYear: number;
    early: number; late: number; difference: number; ratio: number | null;
  }[];
  reason: string | null;
  note: string;
}

export interface CalendarDay {
  date: string;
  doy: number;
  available: boolean;
  state: ObservationState;
  stateCode?: string;
  derived?: DerivedDay | null;
  /** Null (not 0) on a day without delivery evidence: missing ≠ zero. */
  modis: number | null;
  viirs: number | null;
  modisFrp: number | null;
  viirsFrp: number | null;
  total: number | null;
  sensors: Record<Sensor, SensorDayState>;
  baseline: { median: number; ratio: number | null; robustZ: number | null } | null;
}

export interface CalendarBucket {
  key: string;
  label: string;
  start: string;
  end: string;
  modis: number | null;
  viirs: number | null;
  total: number | null;
  modisFrp: number | null;
  viirsFrp: number | null;
  observedDays: number;
  zeroDays: number;
  unknownDays: number;
  /** True when the bucket mixes observed days with unknown ones. */
  lowerBound?: boolean;
  state: ObservationState;
}

export interface CalendarBaseline {
  available: boolean;
  method: string;
  sampleDays: number;
  reason?: string;
  median?: number;
  mad?: number;
  robustSigma?: number;
  p90?: number;
  max?: number;
  min?: number;
  note?: string;
}

export type CalendarPeriod = "day" | "week" | "month" | "season";

export interface CalendarResponse {
  year: number;
  period: CalendarPeriod;
  bbox: [number, number, number, number];
  days: CalendarDay[];
  buckets: CalendarBucket[];
  availableDays: number;
  note: string | null;
  coverage: Coverage;
  region: string;
  summary: {
    observedDays: number;
    zeroDays: number;
    partialDays: number;
    unknownDays: number;
    unavailableDays?: number;
    derivedDays?: number;
    grid?: number;
    derivedUnit?: string;
    totalDetections: number;
    unknownReason: string | null;
    note: string;
  };
  yearComparison?: YearComparison;
  baseline: CalendarBaseline;
}

export interface MonthlyHistorySensor {
  state: ObservationState;
  detections: number | null;
  frpSumMw: number | null;
  observedDays: number;
  deliveryDays: number;
  unavailableDays: number;
  basis: string;
}

export interface MonthlyHistoryAnomaly {
  available: boolean;
  sampleYears: number[];
  sampleCount: number;
  median: number | null;
  mean: number | null;
  mad: number | null;
  robustSigma: number | null;
  robustZ: number | null;
  deviationPercent: number | null;
  classification: string;
}

export interface MonthlyHistoryCell {
  year: number;
  month: number;
  key: string;
  label: string;
  state: ObservationState;
  sensors: Record<Sensor, MonthlyHistorySensor>;
  anomaly: Record<Sensor, MonthlyHistoryAnomaly>;
  harmonizedActivity: {
    cellDays: number | null;
    source: string | null;
    estimated: boolean;
    unit: string;
  };
  harmonizedAnomaly: MonthlyHistoryAnomaly;
}

export interface MonthlyHistoryResponse {
  startYear: number;
  endYear: number;
  bbox: [number, number, number, number];
  months: MonthlyHistoryCell[];
  observedYears: number[];
  coverage: Coverage;
  harmonizedActivity: {
    available: boolean;
    status: string;
    validationStatus: string;
    reason: string;
    referenceSensor: string;
    metric: string;
    factor: number | null;
    candidateFactor: number | null;
    trainingYears: number[];
    holdoutYears: number[];
    trainingMonths: number;
    holdoutMonths: number;
    validation: {
      months: number;
      meanAbsoluteError: number;
      rawMeanAbsoluteError: number;
      meanAbsolutePercentError: number;
      relativeBiasPercent: number;
      improvedOverUnadjustedVIIRS: boolean;
    } | null;
  };
  method: string;
  region: string;
  aoi: Record<string, unknown>;
}

export interface DayDetail {
  date: string;
  state: ObservationState;
  stateLabel: string;
  region: string;
  bbox: [number, number, number, number];
  sensors: Record<Sensor, SensorDayState>;
  confidence: Record<Sensor, Record<string, number>>;
  frp: Record<Sensor, FrpStats>;
  observations: {
    id: string; sensor: Sensor; satellite: string; lat: number; lon: number; time: string;
    frp: number | null; brightness: number | null; confidence: string | null;
    confidenceRaw: string | null; daynight: string | null; version: string; source: string;
  }[];
  coverage: Coverage;
  derived?: DerivedDay | null;
  provenance: { sources: string[]; versions: string[]; delivery: Record<string, unknown> };
  method: string;
}

export interface Cell {
  lat: number;
  lon: number;
  count: number;
  modis: number;
  viirs: number;
  frp: number;
  maxFrp: number;
  high: number;
}

export interface DetectionProps {
  id: string;
  sensor: Sensor;
  instrument: string;
  satellite: string;
  acqDate: string;
  acqTime: string;
  ts: number;
  lat: number;
  lon: number;
  frp: number | null;
  confidence: string;
  confidencePct: number | null;
  confidenceClass: "low" | "nominal" | "high" | null;
  brightness: number | null;
  brightT31: number | null;
  scan: number | null;
  track: number | null;
  daynight: string | null;
  version: string;
  source: string;
}

export interface DetectionCollection {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: DetectionProps }[];
  meta: { returned: number; limit: number };
}

export interface Hfai {
  metric: string;
  unit: string;
  method: string;
  modisDensity: number;
  viirsDensity: number;
  combinedDensity: number;
  meanFrpPerActiveCell: { modis: number; viirs: number; combined: number };
  activeCells: number;
  activeAreaKm2: number;
  cellDays: number;
  modisToViirsRatio: number | null;
  ratioCi95: [number, number] | null;
  pairedCellDays: number;
  coincidentShare: number;
  modisOnlyCellDays: number;
  status: "experimental";
  validation?: string;
  /** Published by the engine: which code path produced these numbers. */
  provenance?: string;
  densityCi95?: [number, number] | null;
  sensorDensityCi95?: { modis: [number, number] | null; viirs: [number, number] | null };
  daysUsed?: number;
  gridDefinition?: { cell: number; method: string } | null;
  cellAreaMethod?: string | null;
  validationStatus?: string;
}

export interface HfaiV2 {
  metric: string;
  unit: string;
  pairedCellDays: number;
  modisMeanFrp: number | null;
  viirsMeanFrp: number | null;
  ratio: number | null;
  ratioCi95: [number, number] | null;
  status: "experimental";
  validation: string;
  note: string;
}

export interface MethodStep {
  id: string;
  name: string;
  status: string;
  unit: string;
  value: Record<string, unknown>;
  note: string;
}

export interface GridSensitivityRow {
  grid: number;
  combinedDensity: number;
  activeCells: number;
  pairedCellDays: number;
  ratio: number | null;
  ratioCi95: [number, number] | null;
}

export interface Harmonization {
  region: string;
  bbox: [number, number, number, number];
  window: {
    start: string | null;
    end: string | null;
    overlapDays: number;
    overlap: string[];
    modisOnlyDays: string[];
    viirsOnlyDays: string[];
    deliveryOverlapDays?: number;
    deliveryOverlap?: string[];
    note?: string;
  };
  sensors: Record<
    Sensor,
    {
      detections: number;
      frp: FrpStats;
      confidence: Record<string, number>;
      pixelAreaKm2: number;
      resolution: string;
      satellites: Record<string, number>;
      detectionsPer1000Km2: number;
      meanFrp: number | null;
    }
  >;
  hfai: Hfai;
  hfaiV2?: HfaiV2;
  methods?: MethodStep[];
  gridSensitivity?: GridSensitivityRow[] | null;
  grid?: number;
  gridChoices?: number[];
  pairedSample: { lat: number; lon: number; day: string; modisFrp: number; viirsFrp: number }[];
  limitations: string[];
}

export interface Anomaly {
  available: boolean;
  reason?: string;
  target?: { date: string; count: number; frp: number } | null;
  baseline?: { median: number; mad: number; robustSigma: number; days: number; min: number; max: number; p90: number } | null;
  deviation?: { absolute: number; relative: number | null; robustZ: number | null; percentile: number; direction: string };
  quality?: { level: "adequate" | "limited" | "insufficient"; baselineDays: number; note: string };
  method?: string;
}

export interface AiStatus {
  provider: string;
  available: boolean;
  model: string | null;
  note: string;
  mode?: "llm" | "deterministic";
  /** True only when this answer was actually rephrased by the model. */
  used?: boolean;
  installed?: number;
  /** Set when the answer used a model the request named, not the env default. */
  requested?: boolean;
}

export interface AiModel {
  name: string;
  sizeBytes: number;
  sizeGb: number | null;
  parameters: string | null;
  quantization: string | null;
  family: string | null;
  modifiedAt: string | null;
}

export interface AiModelsResponse {
  available: boolean;
  models: AiModel[];
  selected?: string | null;
  error?: string;
  note?: string;
  hardware?: { gpu: string; vramGb: number; guidance: string };
}

/**
 * Data-freshness contract from GET /api/freshness (also embedded in /api/meta).
 * Observation time, ingestion time and the last successful check are separate
 * fields on purpose: an hourly check is not an hourly observation.
 */
export interface Freshness {
  generatedAt: string;
  state: "fresh" | "stale" | "never-checked";
  observationWindow: { first: string | null; last: string | null; days: number; note: string };
  lastIngest: number | null;
  lastSuccessAt: string | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  checks: number;
  running: boolean;
  scheduler: { enabled: boolean; intervalSeconds: number; note: string };
  sources: {
    source: string; sensor: string | null; status: string; records: number;
    startedAt: number; finishedAt: number | null; message: string | null;
  }[];
  archiveEnabled: boolean | null;
  archiveNote: string | null;
}

export interface Meta {
  engine: { version: string; observations: number; modis: number; viirs: number };
  coverage: Coverage;
  freshness?: Freshness;
  sources: {
    id: string; label: string; sensor: string; instrument: string; provider: string;
    url: string; access: string; resolution: string; coverage: string; attribution?: string;
  }[];
  regions: { id: string; name: string; bbox: [number, number, number, number]; kind: string; note: string }[];
  runs: { id: number; source: string; sensor: string | null; started_at: number; finished_at: number | null; status: string; records: number; message: string | null }[];
  ai: AiStatus;
  archive: { enabled: boolean; note: string };
  attribution: { label: string; value: string }[];
  generatedAt: string;
}

export interface EvidenceItem {
  label: string;
  value: string;
  kind: string;
}

export interface Section {
  title: string;
  body: string[];
}

export interface Interpretation {
  headline: string;
  sections: Section[];
  evidence: EvidenceItem[];
  followUps: string[];
  limitations: string[];
  phrasedBy?: string;
}

export interface AskSelection {
  observation: Record<string, unknown> | null;
  lat: number;
  lon: number;
  radiusKm: number;
  windowHours: number;
  region: { id: string; name: string; note: string } | null;
  bbox: [number, number, number, number];
  coverage: { first: string; last: string; days: number; sensors: Record<string, unknown> };
  freshness: string;
  nearbySummary: {
    count: number;
    sensors: Record<Sensor, {
      detections: number; maxFrp: number | null; meanFrp: number | null;
      satellites: string[]; day: number; night: number; highConfidence: number;
    }>;
    distanceKm: number | null;
  };
}

export interface NearbyItem {
  id: string;
  sensor: Sensor;
  satellite: string;
  distanceKm: number;
  frp: number | null;
  confidenceClass: string | null;
  acqDate: string;
  acqTime: string;
  lat: number;
  lon: number;
}

export interface AskResponse {
  selection: AskSelection;
  nearbyTop: NearbyItem[];
  interpretation: Interpretation;
  citations: Citation[];
  model: AiStatus;
  generatedAt: string;
}

export interface Citation {
  id: string;
  title: string;
  source: string;
  url: string;
}

export interface IntelligenceResponse {
  answer: Interpretation & { data?: unknown; citations: Citation[] };
  model: AiStatus;
  mode: "llm" | "deterministic";
  modeLabel: string;
  grounding: { status: string; checked: number | null; ungrounded: string[] };
  region: string;
  bbox: [number, number, number, number];
  window: { start: string | null; end: string | null };
  deterministic: boolean;
  latencyMs: number;
}

export interface SensorIndicator {
  sensor: Sensor;
  cellDays: number;
  cells: number;
  activeAreaKm2: number;
  frpTotalMw: number;
  observationDays: number;
  deliveryDaysUsed: number;
  density: number;
  densityUnit: string;
  densityCi95: [number, number] | null;
  ciMethod: string;
}

export interface IndicatorGrid {
  grid: number;
  sensors: Record<Sensor, SensorIndicator>;
  combined: {
    cellDays: number; activeCells: number; activeAreaKm2: number; frpTotalMw: number;
    daysUsed: number; density: number; densityUnit: string;
    densityCi95: [number, number] | null; reduction: string;
  };
  hfaiV2: {
    pairedCellDays: number; modisMeanFrp: number | null; viirsMeanFrp: number | null;
    ratio: number | null; ratioCi95: [number, number] | null; log10Ratio: number | null;
    spearmanRho: number | null; unit: string;
  };
  disagreement: {
    modisOnlyCellDays: number; viirsOnlyCellDays: number; pairedCellDays: number;
    jaccardCells: number | null; coincidenceShare: number; interpretation: string;
  };
  opportunity: { modisDays: number; viirsDays: number; pairedDays: number; adjusted: boolean; note: string };
}

export interface HarmonizationV2 {
  status: string;
  validationStatus: string;
  validationDetail: string;
  selected: IndicatorGrid;
  gridSensitivity: IndicatorGrid[];
  formula: Record<string, string>;
  assumptions: string[];
  limitations: string[];
  aoi: { kind: string; label: string; areaKm2: number };
}

export interface MatchSetting {
  maxKm: number; windowHours: number; pairs: number;
  modisMatchedShare?: number; viirsMatchedShare?: number;
  medianDistanceKm?: number; p90DistanceKm?: number; medianFrpRatio?: number | null;
}

export interface Comparison {
  counts: { modisDetections: number; viirsDetections: number; sampled: boolean; sampleStep: number };
  matching: {
    primaryKm: number; primaryHours: number;
    settings: MatchSetting[];
    detail: {
      pairs: number; medianDistanceKm: number; p90DistanceKm: number; maxDistanceKm: number;
      modisMatchedShare: number; viirsMatchedShare: number;
      frpRatio: number | null; frpRatioCi95: [number, number] | null;
      spearmanRho: number | null; oneToOne: boolean;
      byViirsConfidence: Record<string, { pairs: number; medianFrpRatio?: number | null }>;
    };
    rules: string;
  };
  frpDistribution: { statistic: number | null; pValue: number | null; n1?: number; n2?: number; note: string };
  validationStatus: string;
  limitations: string[];
}
