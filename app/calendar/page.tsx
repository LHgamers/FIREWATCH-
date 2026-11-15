"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarDays, ChevronLeft, ChevronRight, Download, FileJson, Info, Printer, X,
} from "lucide-react";
import { useApi, useMeta } from "@/lib/hooks";
import { useFilters } from "@/components/shell/FiltersProvider";
import { REGION_MAP } from "@/lib/regions";
import { MonthlyHistoryMatrix } from "@/components/calendar/MonthlyHistoryMatrix";
import type { MonthlyHistoryMetric, MonthlyHistoryMode } from "@/components/calendar/MonthlyHistoryMatrix";
import { heatColor } from "@/components/calendar/heatColor";
import {
  Badge, DataNotice, ErrorState, KeyValue, Loading, Panel, PanelHead, SectionTitle, Segmented,
} from "@/components/ui/primitives";
import { SENSOR_COLOR, cn, formatCompact, formatDate, formatInt, formatNum } from "@/lib/format";
import { bboxParam, bboxLabel, parseBbox, type Bbox } from "@/components/map/aoi";
import type {
  CalendarBucket, CalendarDay, CalendarPeriod, CalendarResponse, DayDetail, ObservationState,
  MonthlyHistoryResponse, Sensor, YearComparison,
} from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

const STATE_STYLE: Record<ObservationState, { label: string; hint: string }> = {
  observed: { label: "Observed", hint: "Product delivered and detections were recorded." },
  observed_zero: { label: "Verified zero", hint: "Product delivered, no detections in this area." },
  partial: { label: "Partial", hint: "Only one sensor delivered for this day." },
  unknown: { label: "Unknown", hint: "No delivery evidence. Not zero activity." },
  unavailable: { label: "Unavailable", hint: "The product was not available for this day. Not zero activity." },
};

type Metric = "detections" | "derived";

function DayCell({ day, max, metric, selected, onSelect, index = 0 }: {
  day: CalendarDay; max: number; metric: Metric; selected: boolean;
  onSelect: (d: CalendarDay) => void;
  /** Position in the month, used for a bounded stagger delay. */
  index?: number;
}) {
  // A PRODUCT_UNAVAILABLE day is rendered with the unknown styling rather than
  // breaking the cell; the legend and the API still report the precise code.
  const style = STATE_STYLE[day.state] ?? STATE_STYLE.unknown;
  const derivedDensity = day.derived?.combined?.density ?? null;
  // `null` means "no delivery evidence", not zero, so it never becomes a colour
  // and never prints as a number.
  const value = metric === "derived" ? derivedDensity : day.total;
  // Derived values only exist where a reduction was computed; a day without one
  // keeps the unknown/verified-zero styling rather than a false low colour.
  const bg = day.state === "observed" && value != null && value > 0 ? heatColor(value, max) : undefined;
  const tooltip = metric === "derived"
    ? `${day.date} · ${style.label} · ${derivedDensity == null ? "no derived value" : `${derivedDensity.toFixed(5)} MW km^-2`}`
    : `${day.date} · ${style.label} · ${day.total == null ? "no coverage data" : `${formatInt(day.total)} detections`}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(day)}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "fw-cell-in group relative aspect-square w-full rounded-[3px] border transition-transform",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan focus-visible:ring-offset-1 focus-visible:ring-offset-void",
        day.state === "unknown" && "border-dashed border-line/70 bg-transparent",
        day.state === "observed_zero" && "border-line bg-elevated/40",
        day.state === "partial" && "border-ember/50 bg-ember/10",
        day.state === "observed" && "border-transparent",
        selected && "ring-2 ring-ink/70 ring-offset-1 ring-offset-void",
        "hover:z-10 hover:scale-[1.18]",
      )}
      style={{
        ...(bg ? { backgroundColor: bg } : null),
        // 31 cells × 6 ms stays under 200 ms, so the whole month has arrived
        // before the reader has finished scanning the header.
        "--fw-delay": `${Math.min(index * 6, 190)}ms`,
      } as React.CSSProperties}
    >
      {day.state === "observed_zero" && (
        <span className="absolute inset-[30%] rounded-full border border-muted/60" />
      )}
      {day.state === "partial" && (
        <span className="absolute inset-x-0 bottom-0 h-1/2 rounded-b-[2px] bg-ember/30" />
      )}
      {day.baseline?.robustZ != null && Math.abs(day.baseline.robustZ) >= 2 && (
        <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-ink/80" />
      )}
    </button>
  );
}

function MonthGrid({ label, cells, max, metric, selected, onSelect }: {
  label: string; cells: CalendarDay[]; max: number; metric: Metric;
  selected: string | null; onSelect: (d: CalendarDay) => void;
}) {
  const first = cells[0] ? new Date(`${cells[0].date}T00:00:00Z`) : null;
  const lead = first ? (first.getUTCDay() + 6) % 7 : 0;
  const total = cells.reduce((s, c) => s + (c.total ?? 0), 0);
  const observed = cells.filter((c) => c.state === "observed" || c.state === "observed_zero").length;
  return (
    <div className="rounded-lg border border-line/60 bg-surface/40 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11.5px] font-medium text-ink">{label}</span>
        <span className="font-mono text-[9.5px] tabular-nums text-muted">
          {observed ? formatCompact(total) : "—"}
        </span>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-[3px]">
        {WEEKDAYS.map((w, i) => (
          <span key={`${w}-${i}`} className="text-center font-mono text-[8px] text-muted/60">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {Array.from({ length: lead }).map((_, i) => <span key={`lead-${i}`} />)}
        {cells.map((d, i) => (
          <DayCell key={d.date} day={d} max={max} metric={metric} index={i}
            selected={selected === d.date} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function BucketStrip({ buckets, period }: { buckets: CalendarBucket[]; period: CalendarPeriod }) {
  const max = Math.max(1, ...buckets.map((b) => b.total ?? 0));
  const shown = period === "day"
    ? buckets.filter((b) => (b.total ?? 0) > 0 || b.state === "observed_zero")
    : buckets.filter((b) => b.observedDays > 0 || b.unknownDays < 366);
  return (
    <div className="space-y-1.5">
      {shown.map((b, i) => {
        const total = b.total ?? 0;
        const w = (total / max) * 100;
        const mShare = total && b.modis != null ? (b.modis / total) * 100 : 0;
        return (
          <div key={b.key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
              {b.label}
            </span>
            <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-elevated/40">
              {total > 0 ? (
                <div
                  className="fw-grow-x flex h-full"
                  style={{ width: `${Math.max(2, w)}%`, "--fw-delay": `${i * 55}ms` } as React.CSSProperties}
                >
                  <div style={{ width: `${mShare}%`, backgroundColor: SENSOR_COLOR.modis }} />
                  <div style={{ width: `${100 - mShare}%`, backgroundColor: SENSOR_COLOR.viirs }} />
                </div>
              ) : b.state === "observed_zero" ? (
                <div className="h-full w-full border border-dashed border-line/70" />
              ) : null}
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted">
              {b.total != null ? formatCompact(b.total) : b.state === "observed_zero" ? "0" : "—"}
              {b.lowerBound ? <span title="Some days in this bucket have no coverage data; the number is a lower bound."> ·</span> : null}
            </span>
          </div>
        );
      })}
      <p className="pt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted/60">
        {period === "day" ? "stored days, in order" : `${period} buckets · MODIS / VIIRS split`}
      </p>
    </div>
  );
}

function DayDrawer({ date, region, bbox, polygon, onClose }: {
  date: string; region: string; bbox: Bbox | null; polygon: string | null; onClose: () => void;
}) {
  const { data, error, loading } = useApi<DayDetail>(`/api/day/${date}`,
    polygon ? { polygon } : bbox ? { bbox: bboxParam(bbox) } : { region },
    [polygon, bbox ? bboxParam(bbox) : region]);
  return (
    <div className="fw-backdrop-in fixed inset-0 z-40 flex justify-end bg-void/60 backdrop-blur-sm" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close day detail" className="flex-1 cursor-default" onClick={onClose} />
      <aside className="fw-drawer-in h-full w-full max-w-[520px] overflow-y-auto border-l border-line bg-panel p-5 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="kicker">Day ledger</p>
            <h2 className="mt-1 text-[19px] font-semibold text-ink">{formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h2>
            {data && <p className="mt-1 text-[11.5px] text-muted">{data.stateLabel}</p>}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost px-2 py-1" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {loading && <div className="mt-6"><Loading label="Reading the day" /></div>}
        {error && <div className="mt-6"><ErrorState error={error} /></div>}
        {data && (
          <div className="fw-stagger mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {(["modis", "viirs"] as const).map((s) => {
                const st = data.sensors[s];
                return (
                  <div key={s} className="rounded-lg border border-line/70 bg-surface/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9.5px] uppercase tracking-[0.12em]" style={{ color: SENSOR_COLOR[s] }}>
                        {s}
                      </span>
                      <Badge tone={st.state === "observed" ? "ok" : st.state === "unknown" ? "warn" : "muted"}>
                        {(STATE_STYLE[st.state] ?? STATE_STYLE.unknown).label}
                      </Badge>
                    </div>
                    <p className="mt-2 font-mono text-[20px] tabular-nums text-ink">{formatInt(st.count)}</p>
                    <p className="mt-0.5 text-[10.5px] leading-snug text-muted">{st.evidence}</p>
                    {st.satellites && Object.keys(st.satellites).length > 0 && (
                      <p className="mt-1.5 font-mono text-[9.5px] text-muted/80">
                        {Object.entries(st.satellites).map(([k, v]) => `${k} ${formatCompact(v)}`).join(" · ")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div>
              <SectionTitle>Confidence, as reported</SectionTitle>
              <div className="space-y-1">
                {(["modis", "viirs"] as const).map((s) => {
                  const c = data.confidence[s];
                  const total = Math.max(1, Object.values(c).reduce((a, b) => a + b, 0));
                  return (
                    <div key={s} className="flex items-center gap-2">
                      <span className="w-12 font-mono text-[9.5px] uppercase text-muted">{s}</span>
                      <div className="flex h-2.5 flex-1 overflow-hidden rounded-sm bg-elevated/50">
                        {(["high", "nominal", "low", "unclassified"] as const).map((k) => (
                          <div key={k} style={{ width: `${(c[k] / total) * 100}%` }}
                            className={cn(k === "high" && "bg-ok", k === "nominal" && "bg-cyan", k === "low" && "bg-ember", k === "unclassified" && "bg-line")} />
                        ))}
                      </div>
                      <span className="w-24 text-right font-mono text-[9.5px] text-muted">
                        {formatCompact(c.high)} high
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
                MODIS reports a percentage; VIIRS reports low/nominal/high. The shared class is a display view,
                not a probability of wildfire.
              </p>
            </div>

            <div>
              <SectionTitle>FRP of the strongest detections</SectionTitle>
              <div className="grid grid-cols-2 gap-x-4">
                {(["modis", "viirs"] as const).map((s) => (
                  <div key={s}>
                    <KeyValue label="median" value={`${formatNum(data.frp[s].median)} MW`} />
                    <KeyValue label="p90" value={`${formatNum(data.frp[s].p90)} MW`} />
                    <KeyValue label="max" value={`${formatNum(data.frp[s].max)} MW`} />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <SectionTitle right={<span className="font-mono text-[9px] text-muted">top 25 by FRP</span>}>
                Detections
              </SectionTitle>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line/60">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-elevated/90 backdrop-blur">
                    <tr className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted">
                      <th className="px-2 py-1.5">time</th>
                      <th className="px-2 py-1.5">sensor</th>
                      <th className="px-2 py-1.5 text-right">FRP</th>
                      <th className="px-2 py-1.5 text-right">lat, lon</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.observations.map((o) => (
                      <tr key={o.id} className="border-t border-line/40 text-[10.5px]">
                        <td className="px-2 py-1 font-mono text-muted">{o.time.slice(11, 16)}Z</td>
                        <td className="px-2 py-1">
                          <span className="font-mono text-[9.5px] uppercase" style={{ color: SENSOR_COLOR[o.sensor] }}>
                            {o.sensor}
                          </span>
                          <span className="ml-1 text-muted/70">{o.satellite}</span>
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-ink">
                          {o.frp == null ? "—" : formatNum(o.frp)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-[9.5px] text-muted">
                          {o.lat.toFixed(2)}, {o.lon.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <SectionTitle right={<Badge tone="violet">experimental</Badge>}>Derived intensity</SectionTitle>
              {data.derived ? (
                <>
                  <div className="grid grid-cols-2 gap-x-4">
                    <KeyValue label="combined" value={`${data.derived.combined.density?.toFixed(5) ?? "—"} MW km⁻²`} />
                    <KeyValue label="95% CI" value={data.derived.combined.densityCi95
                      ? `${data.derived.combined.densityCi95[0].toFixed(5)} – ${data.derived.combined.densityCi95[1].toFixed(5)}`
                      : "not reported"} />
                    <KeyValue label="MODIS" value={`${data.derived.modis?.density?.toFixed(5) ?? "—"} MW km⁻²`} />
                    <KeyValue label="VIIRS" value={`${data.derived.viirs?.density?.toFixed(5) ?? "—"} MW km⁻²`} />
                    <KeyValue label="active area" value={`${formatCompact(data.derived.combined.activeAreaKm2)} km²`} />
                    <KeyValue label="cell-days" value={formatInt(data.derived.combined.activeCells)} />
                  </div>
                  <p className="mt-2 text-[10.5px] leading-snug text-muted">
                    Maximum reported FRP per active {data.derived.grid}° cell, divided by exact spherical cell
                    area. Experimental, grid dependent, and not calibrated against any ground truth.
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-muted">
                  No reduction exists for this day, so no derived value is shown. It is not zero.
                </p>
              )}
            </div>

            <div>
              <SectionTitle>Provenance</SectionTitle>
              <KeyValue label="sources" value={data.provenance.sources.join(", ") || "—"} />
              <KeyValue label="versions" value={data.provenance.versions.join(", ") || "—"} />
              <KeyValue label="state" value={(STATE_STYLE[data.state] ?? STATE_STYLE.unknown).label} />
            </div>

            <DataNotice>{data.method}</DataNotice>
          </div>
        )}
      </aside>
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={<Loading label="Loading the burning calendar" />}>
      <CalendarView />
    </Suspense>
  );
}

function CalendarView() {
  const { region } = useFilters();
  const router = useRouter();
  const searchParams = useSearchParams();
  // A deep link may carry an area of interest. The parameter is honoured as
  // given (never silently swapped for the region bbox); an unparseable one is
  // reported instead of being applied.
  const rawBbox = searchParams.get("bbox");
  const rawPolygon = searchParams.get("polygon");
  const linkedBbox = useMemo(() => (rawBbox ? parseBbox(rawBbox) : null), [rawBbox]);
  const bboxError = rawBbox && !linkedBbox
    ? `The linked area "${rawBbox}" is not a valid W,S,E,N extent, so this page used the whole region.`
    : null;
  const clearBbox = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("bbox");
    next.delete("polygon");
    router.replace(next.size ? `/calendar?${next.toString()}` : "/calendar", { scroll: false });
  };
  const { meta } = useMeta();
  const [period, setPeriod] = useState<CalendarPeriod>("day");
  const [sensor, setSensor] = useState<"both" | "modis" | "viirs">("both");
  const [metric, setMetric] = useState<Metric>("detections");
  const [selected, setSelected] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState<MonthlyHistoryMode>("modis");
  const [historyMetric, setHistoryMetric] = useState<MonthlyHistoryMetric>("detections");
  const [anomalySensor, setAnomalySensor] = useState<Sensor>("modis");
  const currentYear = new Date().getUTCFullYear();
  const [historyStartYear, setHistoryStartYear] = useState(2000);
  const [historyEndYear, setHistoryEndYear] = useState(currentYear);

  const years = useMemo(() => {
    const first = meta?.coverage.first ? Number(meta.coverage.first.slice(0, 4)) : null;
    const last = meta?.coverage.last ? Number(meta.coverage.last.slice(0, 4)) : null;
    if (!first || !last) return [new Date().getFullYear()];
    return Array.from({ length: last - first + 1 }, (_, i) => last - i);
  }, [meta]);
  const [year, setYear] = useState<number | null>(null);
  const activeYear = year ?? years[0];

  const scope = rawPolygon
    ? { polygon: rawPolygon }
    : linkedBbox ? { bbox: bboxParam(linkedBbox) } : { region };
  const scopeKey = rawPolygon ?? (linkedBbox ? bboxParam(linkedBbox) : region);
  const { data, error, loading } = useApi<CalendarResponse>("/api/calendar", {
    ...scope, year: activeYear, period, sensor,
  }, [scopeKey, activeYear, period, sensor]);
  const { data: historyData, error: historyError, loading: historyLoading } =
    useApi<MonthlyHistoryResponse>("/api/calendar/history", {
      ...scope, startYear: historyStartYear, endYear: historyEndYear,
    }, [scopeKey, historyStartYear, historyEndYear]);
  const name = rawPolygon
    ? "Linked polygon AOI"
    : linkedBbox ? `Linked area ${bboxLabel(linkedBbox)}` : REGION_MAP[region]?.name ?? "Global";

  const months = useMemo(() => {
    const days = data?.days ?? [];
    return MONTHS.map((label, m) => ({
      label,
      cells: days.filter((d) => Number(d.date.slice(5, 7)) === m + 1),
    }));
  }, [data]);

  const max = useMemo(() => {
    const days = data?.days ?? [];
    if (metric === "derived") {
      const values = days.map((d) => d.derived?.combined?.density ?? 0);
      return Math.max(...values, 1e-9);
    }
    return Math.max(1, ...days.map((d) => d.total ?? 0));
  }, [data, metric]);
  const peak = useMemo(
    () => (data?.days ?? []).reduce<CalendarDay | null>(
      (b, d) => (d.total == null ? b : !b || (b.total ?? -1) < d.total ? d : b), null),
    [data],
  );

  function exportCsv() {
    if (!data) return;
    const head = "date,state,modis,viirs,total,modis_frp_mw,viirs_frp_mw,robust_z";
    const rows = data.days.map((d) => [
      d.date, d.state, d.modis ?? "", d.viirs ?? "", d.total ?? "",
      d.modisFrp ?? "", d.viirsFrp ?? "",
      d.baseline?.robustZ ?? "",
    ].join(","));
    download(`firewatch-calendar-${region}-${activeYear}.csv`, [head, ...rows].join("\n"), "text/csv");
  }

  function exportJson() {
    if (!data) return;
    download(`firewatch-calendar-${region}-${activeYear}.json`, JSON.stringify(data, null, 2), "application/json");
  }

  function openMonth(year: number, month: number) {
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    if (rawPolygon) {
      setYear(year);
      setSelected(monthStart);
      return;
    }
    const params = new URLSearchParams();
    Object.entries(scope).forEach(([key, value]) => params.set(key, String(value)));
    const monthEndDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(monthEndDay).padStart(2, "0")}`;
    params.set("start", monthStart);
    params.set("end", monthEnd);
    router.push(`/map?${params.toString()}`);
  }

  if (loading && !data) return <Loading label="Building the burning calendar" />;
  if (error) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (!data) return null;

  const s = data.summary;

  return (
    <div className="fw-stagger space-y-4">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-3 p-4">
          <div>
            <p className="kicker">Historical explorer</p>
            <h2 className="mt-1 text-[19px] font-semibold text-ink">Monthly record by sensor</h2>
            <p className="mt-1 max-w-3xl text-[11.5px] leading-relaxed text-muted">
              Showing the selected AOI from 2000 through the current UTC year. Months without delivery evidence remain unknown, not zero. Historical FIRMS coverage depends on actual archive ingestion.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
              From year
              <input
                type="number"
                min={2000}
                max={historyEndYear}
                value={historyStartYear}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 2000 && value <= historyEndYear) setHistoryStartYear(value);
                }}
                className="mt-1 block w-24 rounded border border-line bg-elevated/50 px-2 py-1.5 font-mono text-[11px] text-ink"
                aria-label="Historical start year"
              />
            </label>
            <label className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
              Through year
              <input
                type="number"
                min={historyStartYear}
                max={currentYear}
                value={historyEndYear}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= historyStartYear && value <= currentYear) setHistoryEndYear(value);
                }}
                className="mt-1 block w-24 rounded border border-line bg-elevated/50 px-2 py-1.5 font-mono text-[11px] text-ink"
                aria-label="Historical end year"
              />
            </label>
          </div>
        </div>
      </Panel>

      <MonthlyHistoryMatrix
        data={historyData}
        loading={historyLoading}
        error={historyError}
        mode={historyMode}
        metric={historyMetric}
        anomalySensor={anomalySensor}
        onModeChange={setHistoryMode}
        onMetricChange={setHistoryMetric}
        onAnomalySensorChange={setAnomalySensor}
        onSelect={openMonth}
      />

      <Panel>
        <div className="grid gap-5 p-5 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="cyan"><CalendarDays size={10} /> {name}</Badge>
              <Badge tone="muted">{activeYear}</Badge>
              <Badge tone={s.observedDays ? "ok" : "warn"}>{s.observedDays} observed days</Badge>
              {s.zeroDays > 0 && <Badge tone="muted">{s.zeroDays} verified zero</Badge>}
              {s.unknownDays > 0 && <Badge tone="warn">{s.unknownDays} unknown</Badge>}
              {(linkedBbox || rawPolygon) && (
                <button type="button" onClick={clearBbox} title="Clear the linked area"
                  className="inline-flex items-center gap-1 rounded-full border border-violet/50 bg-violet/10 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-violet transition-colors hover:bg-violet/20">
                  linked area <X size={10} />
                </button>
              )}
            </div>
            {bboxError && (
              <p className="mt-2 rounded-md border border-ember/40 bg-ember/10 px-2.5 py-1.5 text-[11px] text-ink/80">
                {bboxError}
              </p>
            )}
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.01em] text-ink">Burning activity calendar</h2>
            <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">
              One cell per day. Colour is <span className="text-ink">{metric === "derived"
                ? "derived intensity density (MW km⁻², experimental)"
                : "detections on a logarithmic scale"}</span>. A hollow ring is a day the product was
              delivered with <span className="text-ink">zero</span> detections here; a dashed cell has no
              delivery evidence and is <span className="text-ink">not</span> a day without fire.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Segmented
                size="sm"
                value={period}
                onChange={(v) => setPeriod(v)}
                options={[
                  { value: "day", label: "Daily" },
                  { value: "week", label: "Weekly" },
                  { value: "month", label: "Monthly" },
                  { value: "season", label: "Seasonal" },
                ]}
              />
              <Segmented
                size="sm"
                value={sensor}
                onChange={(v) => setSensor(v)}
                options={[
                  { value: "both", label: "Both" },
                  { value: "modis", label: "MODIS" },
                  { value: "viirs", label: "VIIRS" },
                ]}
              />
              <Segmented
                size="sm"
                value={metric}
                onChange={(v) => setMetric(v)}
                options={[
                  { value: "detections", label: "Detections" },
                  { value: "derived", label: "Derived density" },
                ]}
              />
              <div className="flex items-center gap-1">
                <button type="button" className="btn btn-ghost px-1.5 py-1" aria-label="Previous year"
                  onClick={() => setYear(Math.max(years[years.length - 1], activeYear - 1))}>
                  <ChevronLeft size={14} />
                </button>
                <span className="font-mono text-[11px] tabular-nums text-ink">{activeYear}</span>
                <button type="button" className="btn btn-ghost px-1.5 py-1" aria-label="Next year"
                  onClick={() => setYear(Math.min(years[0], activeYear + 1))}>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                {[0.05, 0.2, 0.45, 0.7, 1].map((t) => (
                  <span key={t} className="h-3 w-5 rounded-[2px]" style={{ backgroundColor: heatColor(t * max, max) }} />
                ))}
                <span className="ml-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                  {metric === "derived" ? "MW km⁻² (low → high)" : "detections (low → high)"}
                </span>
              </div>
              <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                <span className="h-3 w-3 rounded-[3px] border border-line bg-elevated/40" /> verified zero
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                <span className="h-3 w-3 rounded-[3px] border border-dashed border-line" /> unknown
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                <span className="h-1 w-1 rounded-full bg-ink/80" /> |z| ≥ 2
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "observed", value: s.observedDays, tone: "text-ok" },
                { label: "verified zero", value: s.zeroDays, tone: "text-ink" },
                { label: "partial", value: s.partialDays, tone: "text-ember" },
                { label: "unknown", value: s.unknownDays, tone: "text-muted" },
              ].map((row) => (
                <div key={row.label} className="rounded-lg border border-line/60 bg-elevated/20 px-2.5 py-2">
                  <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-muted/70">{row.label}</p>
                  <p className={cn("mt-0.5 font-mono text-[16px] tabular-nums", row.tone)}>{formatInt(row.value)}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-line/70 bg-surface/50 p-3">
              <SectionTitle right={<span className="font-mono text-[9px] text-muted">{data.baseline.sampleDays} days</span>}>
                Baseline
              </SectionTitle>
              {data.baseline.available ? (
                <>
                  <div className="grid grid-cols-2 gap-x-4">
                    <KeyValue label="median / day" value={formatCompact(data.baseline.median ?? 0)} />
                    <KeyValue label="robust σ" value={formatCompact(data.baseline.robustSigma ?? 0)} />
                    <KeyValue label="p90" value={formatCompact(data.baseline.p90 ?? 0)} />
                    <KeyValue label="max" value={formatCompact(data.baseline.max ?? 0)} />
                  </div>
                  <p className="mt-2 text-[10.5px] leading-snug text-muted">{data.baseline.note}</p>
                </>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted">{data.baseline.reason}</p>
              )}
            </div>
            <div className="rounded-lg border border-line/70 bg-surface/50 p-3">
              <SectionTitle>Window</SectionTitle>
              <KeyValue label="stored" value={`${data.coverage.first ?? "—"} → ${data.coverage.last ?? "—"}`} />
              <KeyValue label="detections" value={formatInt(s.totalDetections)} />
              <KeyValue label="peak day" value={peak ? `${formatDate(peak.date, { day: "numeric", month: "short" })} · ${peak.total == null ? "—" : formatCompact(peak.total)}` : "—"} />
              <KeyValue label="archive" value={data.coverage.archiveEnabled ? "enabled" : "not configured"} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={exportCsv}>
                <Download size={12} /> CSV
              </button>
              <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={exportJson}>
                <FileJson size={12} /> JSON
              </button>
              <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={() => window.print()}>
                <Printer size={12} /> Print
              </button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Panel>
          <PanelHead title="Year at a glance" hint="Click any day to open its ledger" />
          <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {months.map((m) => (
              <MonthGrid key={m.label} label={m.label} cells={m.cells} max={max} metric={metric}
                selected={selected} onSelect={(d) => setSelected(d.date)} />
            ))}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHead title={period === "day" ? "Stored days" : `${period} buckets`} hint="MODIS vs VIIRS" />
            <div className="p-3">
              <BucketStrip buckets={data.buckets} period={period} />
            </div>
          </Panel>
          <Panel>
            <PanelHead title="What this can and cannot say" />
            <div className="space-y-2 p-3 text-[11px] leading-relaxed text-muted">
              <p><span className="text-ink">Can:</span> show when each sensor delivered data, how many thermal
                detections it reported, and how a day compares with the stored baseline.</p>
              <p><span className="text-ink">Cannot:</span> prove a fire was absent on an unknown day, measure
                fire size, or attribute cause. A thermal anomaly is not a wildfire.</p>
              <p><span className="text-ink">Baseline:</span> {data.baseline.method}. Unknown days are excluded,
                never zero-filled.</p>
            </div>
          </Panel>
          <DataNotice>
            {data.coverage.archiveNote ?? "Coverage is limited to the stored near-real-time window."}
          </DataNotice>
        </div>
      </div>

      <YearComparePanel region={region} bbox={linkedBbox} polygon={rawPolygon} year={activeYear} period={period} />

      {selected && <DayDrawer date={selected} region={region} bbox={linkedBbox}
        polygon={rawPolygon}
        onClose={() => setSelected(null)} />}
    </div>
  );
}

function YearComparePanel({ region, bbox, polygon, year, period }: {
  region: string; bbox: Bbox | null; polygon: string | null; year: number; period: CalendarPeriod;
}) {
  const comparePeriod = period === "day" ? "month" : period;
  const prev = year - 1;
  const { data, error } = useApi<YearComparison>("/api/calendar/compare", {
    ...(polygon ? { polygon } : bbox ? { bbox: bboxParam(bbox) } : { region }),
    years: `${prev},${year}`, period: comparePeriod,
  }, [polygon, bbox ? bboxParam(bbox) : region, year, comparePeriod]);
  if (error) {
    return (
      <Panel>
        <PanelHead title={`${prev} vs ${year}`} hint="Year comparison" />
        <div className="p-3 text-[11px] leading-relaxed text-muted">
          The comparison endpoint did not answer: {error}. No year is shown rather than a partial one.
        </div>
      </Panel>
    );
  }
  if (!data) return null;
  const rows = data.comparisons ?? [];
  return (
    <Panel>
      <PanelHead
        title={`${prev} vs ${year}`}
        hint={`${comparePeriod} buckets · only periods present in both years`}
        action={<Badge tone={data.comparisonAvailable ? "ok" : "warn"}>
          {data.comparisonAvailable ? `${rows.length} compared` : "insufficient history"}
        </Badge>}
      />
      <div className="p-3">
        {data.comparisonAvailable ? (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={`${r.bucket}-${r.label}`} className="flex items-center gap-2">
                <span className="w-20 shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
                  {r.label}
                </span>
                <div className="flex h-3 flex-1 items-center gap-1">
                  <span className="fw-grow-x h-3 rounded-sm bg-cyan/70" style={{
                    width: `${Math.max(1, (r.early / Math.max(1, ...rows.flatMap((x) => [x.early, x.late])))) * 100}%`,
                  }} />
                  <span className="fw-grow-x h-3 rounded-sm bg-ember/70" style={{
                    width: `${Math.max(1, (r.late / Math.max(1, ...rows.flatMap((x) => [x.early, x.late])))) * 100}%`,
                    "--fw-delay": "90ms",
                  } as React.CSSProperties} />
                </div>
                <span className="w-28 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted">
                  {formatCompact(r.early)} → {formatCompact(r.late)}
                </span>
              </div>
            ))}
            <p className="pt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted/60">
              cyan = {prev} · ember = {year} · detections
            </p>
          </div>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-muted">{data.reason}</p>
        )}
        <p className="mt-2 border-t border-line/50 pt-2 text-[10.5px] leading-snug text-muted">{data.note}</p>
      </div>
    </Panel>
  );
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
