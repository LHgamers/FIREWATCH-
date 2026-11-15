"use client";

import { AlertTriangle, ChevronRight } from "lucide-react";

import { Badge, Panel, PanelHead } from "@/components/ui/primitives";
import { cn, formatCompact, formatNum } from "@/lib/format";
import type { MonthlyHistoryCell, MonthlyHistoryResponse, Sensor } from "@/lib/types";
import { heatColor } from "./heatColor";

export type MonthlyHistoryMode = "modis" | "viirs" | "anomaly" | "harmonized";
export type MonthlyHistoryMetric = "detections" | "frp";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stateLabel(state: string): string {
  switch (state) {
    case "observed": return "detections recorded";
    case "observed_zero": return "conditional zero after product delivery";
    case "partial": return "partial sensor coverage";
    case "unavailable": return "product unavailable";
    default: return "unknown coverage; not zero";
  }
}

function valueFor(
  cell: MonthlyHistoryCell,
  mode: MonthlyHistoryMode,
  metric: MonthlyHistoryMetric,
  anomalySensor: Sensor,
): number | null {
  if (mode === "harmonized") return cell.harmonizedActivity.cellDays;
  if (mode === "anomaly") return cell.anomaly[anomalySensor].robustZ;
  const value = cell.sensors[mode][metric === "frp" ? "frpSumMw" : "detections"];
  return value;
}

function cellText(
  cell: MonthlyHistoryCell,
  mode: MonthlyHistoryMode,
  metric: MonthlyHistoryMetric,
  anomalySensor: Sensor,
): string {
  const value = valueFor(cell, mode, metric, anomalySensor);
  if (value == null) return "—";
  if (mode === "anomaly") return `${value > 0 ? "+" : ""}${formatNum(value, 1)}σ`;
  if (mode === "harmonized") return formatNum(value, 1);
  return metric === "frp" ? formatNum(value, 1) : formatCompact(value);
}

function tooltip(
  cell: MonthlyHistoryCell,
  mode: MonthlyHistoryMode,
  metric: MonthlyHistoryMetric,
  anomalySensor: Sensor,
  unavailableReason: string,
): string {
  if (mode === "harmonized") {
    const activity = cell.harmonizedActivity;
    const anomaly = cell.harmonizedAnomaly;
    return `${cell.key} · ${activity.cellDays == null ? "unknown coverage; no common-scale value" : `${formatNum(activity.cellDays, 1)} ${activity.unit}`} · ${activity.source ?? "no source"}${activity.estimated ? " (estimated)" : ""} · ${
      anomaly.available
        ? `same-month baseline median ${formatNum(anomaly.median)}, robust z ${anomaly.robustZ == null ? "not defined (no spread)" : formatNum(anomaly.robustZ)}`
        : "insufficient history for common-scale anomaly"
    } · ${unavailableReason}`;
  }
  if (mode === "anomaly") {
    const result = cell.anomaly[anomalySensor];
    return `${cell.key} · ${anomalySensor.toUpperCase()} · ${stateLabel(cell.sensors[anomalySensor].state)} · ${
      result.available
        ? `median ${formatNum(result.median)}, mean ${formatNum(result.mean)}, MAD ${formatNum(result.mad)}, robust z ${result.robustZ == null ? "not defined (no spread)" : formatNum(result.robustZ)}; reference years ${result.sampleYears.join(", ")}`
        : `insufficient history: ${result.sampleYears.length} distinct reference years; at least 3 required`
    }`;
  }
  const sensor = cell.sensors[mode];
  const value = metric === "frp" ? sensor.frpSumMw : sensor.detections;
  return `${cell.key} · ${mode.toUpperCase()} · ${stateLabel(sensor.state)} · ${
    value == null ? "no value" : metric === "frp" ? `${formatNum(value)} MW reported FRP sum` : `${formatCompact(value)} detection records`
  } · ${sensor.deliveryDays} global product-delivery days · ${sensor.basis}`;
}

function cellColor(value: number | null, max: number, mode: MonthlyHistoryMode): string | undefined {
  if (value == null) return undefined;
  if (mode !== "anomaly") return value > 0 ? heatColor(value, max) : undefined;
  if (value === 0) return undefined;
  const alpha = Math.min(0.7, 0.18 + Math.abs(value) / 8);
  return value > 0 ? `rgba(255, 99, 61, ${alpha})` : `rgba(57, 200, 242, ${alpha})`;
}

export function MonthlyHistoryMatrix({
  data,
  loading,
  error,
  mode,
  metric,
  anomalySensor,
  onModeChange,
  onMetricChange,
  onAnomalySensorChange,
  onSelect,
}: {
  data: MonthlyHistoryResponse | null;
  loading: boolean;
  error: string | null;
  mode: MonthlyHistoryMode;
  metric: MonthlyHistoryMetric;
  anomalySensor: Sensor;
  onModeChange: (mode: MonthlyHistoryMode) => void;
  onMetricChange: (metric: MonthlyHistoryMetric) => void;
  onAnomalySensorChange: (sensor: Sensor) => void;
  onSelect: (year: number, month: number) => void;
}) {
  const rows = new Map<number, MonthlyHistoryCell[]>();
  for (const cell of data?.months ?? []) {
    rows.set(cell.year, [...(rows.get(cell.year) ?? []), cell]);
  }

  const selectedSensor = mode === "anomaly" ? anomalySensor : mode === "harmonized" ? null : mode;
  const values = (data?.months ?? [])
    .map((cell) => mode === "harmonized"
      ? cell.harmonizedActivity.cellDays
      : selectedSensor
        ? mode === "anomaly"
          ? cell.anomaly[selectedSensor].robustZ
          : cell.sensors[selectedSensor][metric === "frp" ? "frpSumMw" : "detections"]
        : null)
    .filter((value): value is number => value != null && value > 0);
  const max = Math.max(1, ...values);
  const harmonized = data?.harmonizedActivity;

  return (
    <Panel>
      <PanelHead
        title="Historical monthly activity"
        hint={data ? `${data.startYear}–${data.endYear} · ${data.region}` : "year × month · stored evidence only"}
        action={<Badge tone={loading ? "muted" : error ? "warn" : "cyan"}>{loading ? "updating" : error ? "unavailable" : `${data?.observedYears.length ?? 0} years with records`}</Badge>}
      />
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {([
            ["modis", "MODIS"],
            ["viirs", "VIIRS"],
            ["anomaly", "Historical anomaly"],
            ["harmonized", "Harmonized activity"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onModeChange(value)}
              aria-pressed={mode === value}
              className={cn(
                "btn px-2 py-1 text-[10px]",
                mode === value && "btn-primary",
                value === "harmonized" && "border-dashed",
              )}
              title={value === "harmonized" ? harmonized?.reason : undefined}
            >
              {label}
              {value === "harmonized" ? <span className="ml-1 text-[8px]">EXP</span> : null}
            </button>
          ))}
          {mode === "anomaly" ? (
            <div className="inline-flex rounded-md border border-line bg-elevated/40 p-0.5">
              {(["modis", "viirs"] as const).map((sensor) => (
                <button
                  key={sensor}
                  type="button"
                  onClick={() => onAnomalySensorChange(sensor)}
                  aria-pressed={anomalySensor === sensor}
                  className={cn(
                    "rounded px-2 py-0.5 font-mono text-[9px] uppercase",
                    anomalySensor === sensor ? "bg-cyan/15 text-cyan" : "text-muted",
                  )}
                >
                  {sensor}
                </button>
              ))}
            </div>
          ) : null}
          {mode !== "anomaly" && mode !== "harmonized" ? (
            <div className="inline-flex rounded-md border border-line bg-elevated/40 p-0.5">
              {([
                ["detections", "Records"],
                ["frp", "FRP sum (MW)"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onMetricChange(value)}
                  aria-pressed={metric === value}
                  className={cn(
                    "rounded px-2 py-0.5 font-mono text-[9px]",
                    metric === value ? "bg-cyan/15 text-cyan" : "text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-ember/40 bg-ember/10 p-3 text-[11px] text-muted">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-ember" />
            <p>Historical calendar could not be loaded: {error}</p>
          </div>
        ) : null}
        {mode === "harmonized" ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-300/25 bg-amber-300/5 p-3 text-[11px] leading-relaxed text-muted">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
            <p>
              {harmonized?.reason ?? "No common-scale monthly series is available."}
              {" "}Where covered, the common-scale value uses MODIS occupied cell-days; VIIRS substitutes only when the region-specific factor improves later-year holdout error. This experimental index is not a fire-intensity measure.
            </p>
          </div>
        ) : null}

        <div className="max-h-[62vh] overflow-auto rounded-md border border-line/60">
          <table className="w-full min-w-[780px] border-collapse text-center">
            <thead className="sticky top-0 z-10 bg-elevated/95 backdrop-blur">
              <tr className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                <th className="sticky left-0 z-20 border-b border-line/60 bg-elevated px-2 py-2 text-left">Year</th>
                {MONTHS.map((month) => <th key={month} className="border-b border-line/60 px-1 py-2">{month}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...rows.keys()].sort((a, b) => b - a).map((year) => (
                <tr key={year} className="border-b border-line/30 last:border-0">
                  <th className="sticky left-0 z-[1] bg-panel px-2 py-1.5 text-left font-mono text-[10px] tabular-nums text-ink">{year}</th>
                  {MONTHS.map((_, index) => {
                    const cell = rows.get(year)?.find((item) => item.month === index + 1);
                    if (!cell) return <td key={index} className="p-1"><span className="block h-8 rounded border border-dashed border-line/50" /></td>;
                    const sensor = mode === "anomaly" ? anomalySensor : mode === "harmonized" ? null : mode;
                    const sensorState = sensor ? cell.sensors[sensor] : null;
                    const value = valueFor(cell, mode, metric, anomalySensor);
                    const unknown = mode === "harmonized"
                      ? value == null
                      : sensorState?.state === "unknown";
                    const knownZero = mode === "harmonized"
                      ? value === 0
                      : sensorState?.state === "observed_zero";
                    const label = cellText(cell, mode, metric, anomalySensor);
                    return (
                      <td key={cell.key} className="p-1">
                        <button
                          type="button"
                          title={tooltip(cell, mode, metric, anomalySensor, harmonized?.reason ?? "calibration unavailable")}
                          aria-label={tooltip(cell, mode, metric, anomalySensor, harmonized?.reason ?? "calibration unavailable")}
                          onClick={() => onSelect(cell.year, cell.month)}
                          className={cn(
                            "group relative flex h-8 w-full items-center justify-center rounded border font-mono text-[9px] tabular-nums transition-colors hover:border-ink/60",
                            unknown && "border-dashed border-line/60 text-muted/45",
                            knownZero && "border-line/60 bg-elevated/30 text-muted",
                            (mode === "harmonized" ? value != null && value > 0 : sensorState?.state === "observed") && "border-transparent text-ink",
                            mode === "harmonized" && value == null && "border-dashed border-line/40 text-muted/45",
                          )}
                          style={{
                            backgroundColor: unknown || knownZero
                              ? undefined
                              : cellColor(value, max, mode),
                          }}
                        >
                          {label}
                          {knownZero ? <span className="absolute inset-[34%] rounded-full border border-muted/50" /> : null}
                          {mode === "anomaly" && cell.anomaly[anomalySensor].classification === "unusual"
                            ? <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-ink" />
                            : null}
                          <ChevronRight className="sr-only" size={10} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-2 text-[10px] leading-relaxed text-muted">
          <p>
            {mode === "anomaly"
              ? "Anomaly is same-month sensor-specific detection counts vs the median/MAD from at least 3 other years. A zero-spread baseline has no z-score."
              : metric === "frp" && mode !== "harmonized"
                ? "FRP sum is a descriptive sum of reported MW detections, not burned area or a direct measure of unique-fire intensity."
                : mode === "harmonized"
                  ? `Experimental common-scale metric: ${harmonized?.metric ?? "occupied cell-days"}. MODIS is the reference; VIIRS substitution is shown only when later-year internal validation improves error.`
                  : "Sensors are never added together here. A detected thermal anomaly is not automatically a confirmed wildfire."}
          </p>
          <p className="shrink-0">{loading ? "Refreshing…" : "Select a month to inspect its date window."}</p>
        </div>
      </div>
    </Panel>
  );
}
