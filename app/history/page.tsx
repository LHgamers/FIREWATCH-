"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell as RCell, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowRight, FlaskConical, TrendingUp } from "lucide-react";
import { useApi, useMeta } from "@/lib/hooks";
import { useFilters } from "@/components/shell/FiltersProvider";
import { useChartTokens } from "@/lib/theme";
import { useChartMotion } from "@/components/motion";
import { REGION_MAP } from "@/lib/regions";
import {
  Badge, DataNotice, EmptyState, ErrorState, KeyValue, Loading, Panel, PanelHead, Stat,
} from "@/components/ui/primitives";
import { SENSOR_COLOR, cn, formatCompact, formatDate, formatInt, formatNum } from "@/lib/format";
import { bboxLabel, bboxParam, parseBbox, type Bbox } from "@/components/map/aoi";
import type { Anomaly, Summary, TimeseriesPoint } from "@/lib/types";

interface SeriesResponse { series: TimeseriesPoint[]; days: string[]; bucket: string }

export default function HistoryPage() {
  return (
    <Suspense fallback={<Loading label="Loading the stored window" />}>
      <HistoryView />
    </Suspense>
  );
}

function HistoryView() {
  const t = useChartTokens();
  const chartMotion = useChartMotion();
  const { region } = useFilters();
  const { meta } = useMeta();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [bucket, setBucket] = useState<"day" | "week">("day");
  // A linked area of interest is applied exactly, never replaced by the region.
  const rawBbox = searchParams.get("bbox");
  const linkedBbox: Bbox | null = useMemo(() => (rawBbox ? parseBbox(rawBbox) : null), [rawBbox]);
  const bboxError = rawBbox && !linkedBbox
    ? `The linked area "${rawBbox}" is not a valid W,S,E,N extent, so this page used the whole region.`
    : null;
  const scope = linkedBbox ? { bbox: bboxParam(linkedBbox) } : { region };
  const scopeKey = linkedBbox ? bboxParam(linkedBbox) : region;
  const clearBbox = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("bbox");
    router.replace(next.size ? `/history?${next.toString()}` : "/history", { scroll: false });
  };
  const series = useApi<SeriesResponse>("/api/timeseries", { ...scope, bucket }, [scopeKey, bucket]);
  const summary = useApi<Summary>("/api/summary", scope, [scopeKey]);
  const anomaly = useApi<Anomaly>("/api/anomaly", scope, [scopeKey]);
  const name = linkedBbox ? `Linked area ${bboxLabel(linkedBbox)}` : REGION_MAP[region]?.name ?? "Global";

  const points = series.data?.series ?? [];
  // Days without coverage evidence carry a null total, so they never win a
  // "peak" comparison and never sort as if they were quiet days.
  const peak = useMemo(
    () => points.reduce<TimeseriesPoint | null>(
      (b, p) => (p.total == null ? b : !b || (b.total ?? -1) < p.total ? p : b), null),
    [points],
  );
  const topDays = useMemo(
    () => [...points].filter((p) => p.total != null).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 5),
    [points],
  );
  const frpBands = useMemo(() => {
    const m = summary.data?.sensors.modis.frp;
    const v = summary.data?.sensors.viirs.frp;
    if (!m || !v) return [];
    return [
      { band: "median", modis: m.median ?? 0, viirs: v.median ?? 0 },
      { band: "p90", modis: m.p90 ?? 0, viirs: v.p90 ?? 0 },
      { band: "max", modis: m.max ?? 0, viirs: v.max ?? 0 },
    ];
  }, [summary.data]);

  const a = anomaly.data;
  const z = a?.deviation?.robustZ;

  return (
    <div className="fw-stagger space-y-4">
      {(linkedBbox || bboxError) && (
        <div className="flex flex-wrap items-center gap-2">
          {linkedBbox && (
            <button type="button" onClick={clearBbox} title="Clear the linked area"
              className="inline-flex items-center gap-1 rounded-full border border-violet/50 bg-violet/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-violet hover:bg-violet/20">
              linked area · {bboxLabel(linkedBbox)} · clear
            </button>
          )}
          {bboxError && <span className="text-[11px] text-ember">{bboxError}</span>}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Detections in window" value={summary.loading ? "—" : formatInt(summary.data?.totalDetections)} icon={<TrendingUp size={14} />} tone="cyan" />
        <Stat label="Peak day" value={peak ? formatDate(peak.date, { day: "2-digit", month: "short" }) : "—"} delta={peak ? `${formatInt(peak.total)} detections` : "—"} />
        <Stat label="Median FRP (MODIS / VIIRS)" value={summary.data ? `${formatNum(summary.data.sensors.modis.frp.median, 1)} / ${formatNum(summary.data.sensors.viirs.frp.median, 1)}` : "—"} unit="MW" tone="ember" />
        <Stat
          label="Robust deviation"
          value={z !== undefined && z !== null ? z.toFixed(2) : "n/a"}
          unit="z"
          delta={a?.quality ? `${a.quality.level} baseline · ${a.quality.baselineDays} days` : "no baseline"}
          tone={z !== undefined && z !== null && z > 1.5 ? "ember" : "default"}
        />
      </div>

      <Panel>
        <PanelHead
          title="Activity series"
          hint={`${name} · ${bucket === "day" ? "daily" : "weekly"} · MODIS vs VIIRS`}
          action={
            <div className="flex rounded-md border border-line bg-elevated/50 p-0.5">
              {(["day", "week"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setBucket(b)}
                  className={cn("rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em]", bucket === b ? "bg-cyan/15 text-cyan" : "text-muted hover:text-ink")}
                >
                  {b}
                </button>
              ))}
            </div>
          }
        />
        <div className="p-3">
          {series.error ? <ErrorState error={series.error} onRetry={() => window.location.reload()} /> : null}
          {series.loading ? <Loading label="Loading series" /> : null}
          {!series.loading && points.length === 0 ? (
            <EmptyState title="No series for this area" body="No stored detections fall inside the selected region." />
          ) : null}
          {points.length ? (
            <div className="h-[300px] w-full">
              <ResponsiveContainer>
                <AreaChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="hModis" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SENSOR_COLOR.modis} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={SENSOR_COLOR.modis} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="hViirs" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SENSOR_COLOR.viirs} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={SENSOR_COLOR.viirs} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={t.grid} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }} tickFormatter={(d: string) => d.slice(5)} axisLine={{ stroke: t.grid }} tickLine={false} minTickGap={16} />
                  <YAxis tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }} tickFormatter={formatCompact} axisLine={false} tickLine={false} width={46} />
                  <Tooltip
                    contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: t.axis, fontFamily: "var(--font-mono)", fontSize: 10 }}
                    formatter={(value: number, key: string) => [`${formatInt(value)} detections`, key.toUpperCase()]}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, fontFamily: "var(--font-mono)", color: t.axis }} />
                  <Area type="monotone" dataKey="modis" name="MODIS" stroke={SENSOR_COLOR.modis} fill="url(#hModis)" strokeWidth={1.6} dot={false}
                    isAnimationActive={chartMotion.isAnimationActive}
                    animationDuration={chartMotion.animationDuration}
                    animationBegin={chartMotion.animationBegin}
                    animationEasing={chartMotion.animationEasing} />
                  <Area type="monotone" dataKey="viirs" name="VIIRS" stroke={SENSOR_COLOR.viirs} fill="url(#hViirs)" strokeWidth={1.6} dot={false}
                    isAnimationActive={chartMotion.isAnimationActive}
                    animationDuration={chartMotion.animationDuration}
                    animationBegin={chartMotion.animationBegin + 120}
                    animationEasing={chartMotion.animationEasing} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-5">
          <PanelHead title="FRP distribution" hint="Reported MW per detection · log scale" icon={<FlaskConical size={14} />} />
          <div className="h-[220px] p-2">
            <ResponsiveContainer>
              <BarChart data={frpBands} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={t.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="band" tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={{ stroke: t.grid }} tickLine={false} />
                <YAxis
                  scale="log"
                  domain={[1, "auto"]}
                  allowDataOverflow
                  tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v))}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, borderRadius: 8, fontSize: 11 }}
                  formatter={(value: number, key: string) => [`${formatNum(value, 1)} MW`, key.toUpperCase()]}
                />
                <Legend wrapperStyle={{ fontSize: 10, fontFamily: "var(--font-mono)", color: t.axis }} />
                <Bar dataKey="modis" name="MODIS" fill={SENSOR_COLOR.modis} radius={[3, 3, 0, 0]}
                  isAnimationActive={chartMotion.isAnimationActive}
                  animationDuration={chartMotion.animationDuration}
                  animationBegin={chartMotion.animationBegin}
                  animationEasing={chartMotion.animationEasing} />
                <Bar dataKey="viirs" name="VIIRS" fill={SENSOR_COLOR.viirs} radius={[3, 3, 0, 0]}
                  isAnimationActive={chartMotion.isAnimationActive}
                  animationDuration={chartMotion.animationDuration}
                  animationBegin={chartMotion.animationBegin + 120}
                  animationEasing={chartMotion.animationEasing} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="px-4 pb-3 text-[10.5px] leading-relaxed text-muted">
            FRP is radiant power at the acquisition instant, not burned area. MODIS integrates it over a
            seven-times larger pixel, which is why its per-detection values are higher.
          </p>
        </Panel>

        <Panel className="xl:col-span-4">
          <PanelHead title="Baseline assessment" hint="Robust statistics, not a forecast" />
          <div className="space-y-3 p-4">
            {anomaly.loading ? <Loading label="Computing baseline" /> : null}
            {a && !a.available ? <EmptyState title="No baseline" body={a.reason ?? "Not enough stored days."} /> : null}
            {a?.available && a.target ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <MiniStat label="Target day" value={formatDate(a.target.date, { day: "2-digit", month: "short" })} />
                  <MiniStat label="Detections" value={formatInt(a.target.count)} />
                  <MiniStat label="Baseline median" value={a.baseline ? formatInt(a.baseline.median) : "—"} />
                  <MiniStat label="Baseline days" value={String(a.quality?.baselineDays ?? "—")} />
                  <MiniStat label="Robust z" value={a.deviation?.robustZ !== null && a.deviation?.robustZ !== undefined ? a.deviation.robustZ.toFixed(2) : "n/a"} />
                  <MiniStat label="Percentile" value={a.deviation ? `${a.deviation.percentile.toFixed(0)}%` : "—"} />
                </div>
                <div className="rounded-md border border-line/60 bg-elevated/25 p-2.5">
                  <p className="text-[10.5px] leading-relaxed text-muted">{a.quality?.note}</p>
                </div>
                <p className="font-mono text-[9.5px] leading-relaxed text-muted/70">{a.method}</p>
              </>
            ) : null}
            <DataNotice>
              An elevated z-score is a statistical statement about detection counts. It is not an emergency,
              a severity rating or a forecast.
            </DataNotice>
          </div>
        </Panel>

        <Panel className="xl:col-span-3">
          <PanelHead title="Strongest days" hint="Ranked by detections" />
          <div className="divide-y divide-line/40">
            {topDays.map((d) => (
              <div key={d.date} className="flex items-center justify-between gap-2 px-3 py-2">
                <div>
                  <p className="font-mono text-[11px] text-ink">{d.date}</p>
                  <p className="font-mono text-[9.5px] text-muted">
                    {formatInt(d.modis)} MODIS · {formatInt(d.viirs)} VIIRS
                  </p>
                </div>
                <span className="value text-[11px]">{formatInt(d.total)}</span>
              </div>
            ))}
            {topDays.length === 0 ? <p className="px-4 py-3 text-[11px] text-muted">No days in window.</p> : null}
          </div>
          <div className="p-3">
            <Link href="/map" className="link-quiet inline-flex items-center gap-1">
              Inspect on the map <ArrowRight size={10} />
            </Link>
          </div>
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHead title="Sensor profile" hint="Same window, same region" />
          <div className="space-y-1 p-4">
            <KeyValue label="MODIS detections" value={formatInt(summary.data?.sensors.modis.detections)} />
            <KeyValue label="VIIRS detections" value={formatInt(summary.data?.sensors.viirs.detections)} />
            <KeyValue label="MODIS high confidence" value={formatInt(summary.data?.sensors.modis.confidence.high)} />
            <KeyValue label="VIIRS high confidence" value={formatInt(summary.data?.sensors.viirs.confidence.high)} />
            <KeyValue label="Daytime detections" value={formatInt((summary.data?.sensors.modis.dayDetections ?? 0) + (summary.data?.sensors.viirs.dayDetections ?? 0))} />
            <KeyValue label="Night-time detections" value={formatInt((summary.data?.sensors.modis.nights ?? 0) + (summary.data?.sensors.viirs.nights ?? 0))} />
          </div>
        </Panel>
        <Panel>
          <PanelHead title="What this window can and cannot tell you" hint="Eight days is not a climatology" />
          <ul className="space-y-2 p-4 text-[11.5px] leading-relaxed text-muted">
            <li><span className="text-ok">Can:</span> describe recent activity, compare the two sensor footprints, and locate the current hotspots in this region.</li>
            <li><span className="text-ok">Can:</span> say whether the latest day deviates from the stored days, with the baseline size stated.</li>
            <li><span className="text-ember">Cannot:</span> claim seasonality, year-over-year change or a long-term trend — the archive is not configured.</li>
            <li><span className="text-ember">Cannot:</span> attribute cause, burned area, or fire behaviour from thermal anomalies alone.</li>
          </ul>
          <div className="px-4 pb-4">
            <Link href="/settings" className="link-quiet">Configure FIRMS archive access →</Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line/60 bg-elevated/25 px-2 py-1.5">
      <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-muted/70">{label}</p>
      <p className="value mt-0.5 text-[11.5px]">{value}</p>
    </div>
  );
}
