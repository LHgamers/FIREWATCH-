"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, CalendarDays, Compass, Crosshair, Flame, Globe2,
  Layers, Radio, Satellite, ShieldCheck, Sparkles, TrendingUp,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useApi, useMeta } from "@/lib/hooks";
import { useFilters } from "@/components/shell/FiltersProvider";
import { useChartTokens } from "@/lib/theme";
import { REGIONS, REGION_MAP } from "@/lib/regions";
import {
  Badge, ConfidenceBadge, DataNotice, EmptyState, ErrorState, Loading, Panel, PanelHead,
  SectionTitle, SensorChip, Skeleton, Stat,
} from "@/components/ui/primitives";
import { AnimatedNumber, RevealSection, useSeriesMotion } from "@/components/motion";
import {
  SENSOR_COLOR, cn, formatCompact, formatDate, formatDateTime, formatInt, formatNum, relativeAge,
} from "@/lib/format";
import type {
  Anomaly, Cell, DetectionCollection, Harmonization, Summary, TimeseriesPoint,
} from "@/lib/types";

interface SeriesResponse { series: TimeseriesPoint[]; days: string[]; bucket: string }

export default function DashboardPage() {
  const { region, setRegion } = useFilters();
  const { meta } = useMeta();
  const [bucket, setBucket] = useState<"day" | "week">("day");

  const summary = useApi<Summary>("/api/summary", { region });
  const series = useApi<SeriesResponse>("/api/timeseries", { region, bucket });
  const harm = useApi<Harmonization>("/api/harmonization", { region });
  const anomaly = useApi<Anomaly>("/api/anomaly", { region });
  const hottest = useApi<DetectionCollection>("/api/observations", { region, limit: 6 });

  const regionSummary = useMemo(() => {
    const s = summary.data;
    if (!s) return null;
    const m = s.sensors.modis;
    const v = s.sensors.viirs;
    return {
      total: s.totalDetections,
      modis: m.detections,
      viirs: v.detections,
      days: s.dataDays?.length ?? 0,
      frp: s.frpSum,
      high: m.confidence.high + v.confidence.high,
      medianFrp: [...(m.frp.median ? [m.frp.median] : []), ...(v.frp.median ? [v.frp.median] : [])],
      satellites: { ...m.satellites, ...v.satellites },
    };
  }, [summary.data]);

  const name = REGION_MAP[region]?.name ?? "Global";
  const lastDay = meta?.coverage?.last ?? summary.data?.dataDays?.slice(-1)[0] ?? null;
  const firstDay = meta?.coverage?.first ?? summary.data?.dataDays?.[0] ?? null;
  const days = meta?.coverage?.days?.length ?? summary.data?.dataDays?.length ?? 0;
  const sensor = meta?.coverage?.sensors;
  const ingestedAt = useMemo(() => Object.values(meta?.coverage?.sensors ?? {})
    .reduce((newest, s) => Math.max(newest, s.ingestedAt ?? 0), 0), [meta]);
  // The newest acquisition and the newest ingestion can come from different
  // sensors, so the hero names the sensor it is quoting instead of blending them.
  const newestSensor = useMemo(() => Object.entries(meta?.coverage?.sensors ?? {})
    .sort((a, b) => (b[1].lastDay ?? "").localeCompare(a[1].lastDay ?? ""))[0], [meta]);
  const ingestedIso = ingestedAt ? new Date(ingestedAt).toISOString() : null;

  return (
    <div className="space-y-4">
      {/* Hero */}
      <section className="panel fw-panel relative overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-[0.55]" />
        <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-cyan/10 blur-3xl" />
        <div className="fw-hero-scan" aria-hidden="true" />
        <div className="relative grid gap-6 p-5 lg:grid-cols-[1.35fr_1fr] lg:p-6">
          <div className="fw-stagger">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="cyan"><Globe2 size={10} /> {name}</Badge>
              <Badge tone="muted">{firstDay} → {lastDay}</Badge>
              <Badge tone={meta?.archive.enabled ? "ok" : "warn"}>
                {meta?.archive.enabled ? "archive enabled" : "NRT window"}
              </Badge>
            </div>
            <h2 className="mt-3 max-w-xl text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[28px]">
              {summary.loading ? (
                <span className="flex flex-col gap-2">
                  <Skeleton className="h-6 w-64" />
                  <Skeleton className="h-6 w-40" />
                </span>
              ) : (
                <>
                  <AnimatedNumber value={regionSummary?.total} fallback="0" /> thermal anomalies,{" "}
                  {days} days of coverage
                </>
              )}
            </h2>
            <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">
              Harmonized MODIS and VIIRS detections over {name.toLowerCase()}. Every figure on this page is
              computed from stored NASA observations — no estimates, no synthetic values.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Link href="/map" className="btn btn-primary">
                <Layers size={14} /> Open fire map
              </Link>
              <Link href="/intelligence" className="btn">
                <Sparkles size={14} /> Ask the analyst
              </Link>
              <Link href="/calendar" className="btn btn-ghost">
                <CalendarDays size={14} /> Activity calendar
              </Link>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10.5px] text-muted">
              <span className="flex items-center gap-1.5">
                <span className={cn("fw-live h-1.5 w-1.5 rounded-full", meta ? "bg-ok text-ok" : "bg-ember text-ember")} />
                {meta ? "NASA FIRMS feed reachable" : "connecting to engine"}
              </span>
              <span>MODIS C6.1 · 1 km</span>
              {/* The store holds NOAA-20 and NOAA-21 only; Suomi-NPP has zero rows
                  here, so the count is stated from the data, not the programme. */}
              <span>VIIRS 375 m · NOAA-20 / NOAA-21</span>
              <span>UTC timestamps</span>
            </div>
          </div>

          <EarthView date={lastDay} />
        </div>
      </section>

      {/* KPI row */}
      <RevealSection className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 fw-stagger" as="section">
        <Stat
          label="Detections in window"
          value={
            summary.loading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <AnimatedNumber value={regionSummary?.total} fallback="—" />
            )
          }
          unit="records"
          icon={<Activity size={15} />}
          tone="cyan"
          delta={summary.data ? `${formatInt(regionSummary?.high)} high-confidence` : undefined}
        />
        <Stat
          label="MODIS / VIIRS split"
          value={
            summary.loading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <>
                <AnimatedNumber value={regionSummary?.modis} format={formatCompact} fallback="—" />
                <span className="mx-1 text-muted/60">/</span>
                <AnimatedNumber value={regionSummary?.viirs} format={formatCompact} fallback="—" />
              </>
            )
          }
          icon={<Satellite size={15} />}
          delta={summary.data ? `${days} observation days · ${formatNum(regionSummary?.frp ? regionSummary.frp / 1000 : null, 0)}k MW summed FRP` : undefined}
        />
        <Stat
          label="Harmonized intensity (experimental)"
          value={
            harm.loading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <AnimatedNumber
                value={harm.data?.hfai.combinedDensity}
                format={(v) => formatNum(v, 4)}
                fallback="—"
              />
            )
          }
          unit="MW km⁻² d⁻¹"
          icon={<Flame size={15} />}
          tone="ember"
          delta={
            harm.data?.hfai.modisToViirsRatio
              ? `MODIS/VIIRS ratio ${harm.data.hfai.modisToViirsRatio} · ${harm.data.hfai.pairedCellDays} cell-days`
              : "insufficient overlap for a ratio"
          }
        />
        <Stat
          label="Latest acquisition"
          value={lastDay ? formatDate(lastDay, { day: "2-digit", month: "short" }) : "—"}
          icon={<Radio size={15} />}
          tone="ok"
          delta={newestSensor?.[1]?.ingestedAt
            ? `${newestSensor[0].toUpperCase()} · stored ${relativeAge(new Date(newestSensor[1].ingestedAt).toISOString())}`
            : "engine status unavailable"}
        />
      </RevealSection>

      {/* Main grid */}
      <section className="grid gap-3 xl:grid-cols-12">
        <RevealSection className="xl:col-span-8">
        <Panel className="h-full">
          <PanelHead
            title="Activity through the stored window"
            hint={`${bucket === "day" ? "Daily" : "Weekly"} detections · MODIS vs VIIRS · ${name}`}
            action={
              <div className="flex items-center gap-1 rounded-md border border-line bg-elevated/50 p-0.5">
                {(["day", "week"] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => setBucket(b)}
                    className={cn(
                      "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em]",
                      bucket === b ? "bg-cyan/15 text-cyan" : "text-muted hover:text-ink",
                    )}
                  >
                    {b}
                  </button>
                ))}
              </div>
            }
          />
          <div className="px-2 pb-3 pt-4">
            {series.error ? (
              <ErrorState error={series.error} onRetry={() => window.location.reload()} />
            ) : series.loading || !series.data ? (
              <Loading label="Aggregating daily detections" />
            ) : series.data.series.length === 0 ? (
              <EmptyState
                title="No activity in this window"
                body="The selected region has no stored detections. Try another region or check data coverage."
              />
            ) : (
              <ActivityChart series={series.data.series} />
            )}
          </div>
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-4" delay={60}>
        <Panel>
          <PanelHead title="Data integrity" hint="Provenance, coverage and ingestion" icon={<ShieldCheck size={14} />} />
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-2">
              <MiniKpi label="Data days" value={String(days)} />
              <MiniKpi label="Sensors" value={String(Object.keys(meta?.coverage?.sensors ?? {}).length || "—")} />
              <MiniKpi label="MODIS det." value={formatCompact(meta?.engine.modis)} />
              <MiniKpi label="VIIRS det." value={formatCompact(meta?.engine.viirs)} />
            </div>
            <div className="rounded-md border border-line/60 bg-elevated/30 p-2.5">
              <SectionTitle>Acquisition vs ingestion</SectionTitle>
              <p className="mt-1 font-mono text-[10.5px] text-ink/90">
                {firstDay ? formatDate(firstDay) : "—"} → {lastDay ? formatDate(lastDay) : "—"}
              </p>
              <p className="mt-0.5 font-mono text-[9.5px] text-muted">
                MODIS → {sensor?.modis?.lastDay ? formatDate(sensor.modis.lastDay) : "—"}
                {" · "}VIIRS → {sensor?.viirs?.lastDay ? formatDate(sensor.viirs.lastDay) : "—"}
              </p>
              <p className="mt-1 font-mono text-[9.5px] text-muted">
                Stored {formatDateTime(ingestedIso)}{ingestedIso ? ` · ${relativeAge(ingestedIso)}` : ""}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted">
                Acquisition is the satellite overpass date. Ingestion is when this server stored the
                rows. The two clocks are different and can be a day apart.
              </p>
            </div>
            <div className="space-y-1.5">
              <SectionTitle>Ingestion runs</SectionTitle>
              {(meta?.runs ?? []).slice(0, 3).map((run) => (
                <div key={run.id} className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-elevated/30 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[10.5px] text-ink/90">{run.source}</p>
                    <p className="font-mono text-[9.5px] text-muted">
                      {run.sensor ?? "both"} · {relativeAge(new Date(run.started_at).toISOString())}
                    </p>
                  </div>
                  <Badge tone={run.status === "ok" ? "ok" : "warn"}>{run.status}</Badge>
                </div>
              ))}
              {!meta?.runs?.length ? <p className="text-[11px] text-muted">No ingestion runs recorded.</p> : null}
            </div>
            <DataNotice>{meta?.archive.note ?? "Checking archive access…"}</DataNotice>
          </div>
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-4">
        <Panel className="h-full">
          <PanelHead
            title="Regional ranking"
            hint="Stored detections by study region"
            action={<span className="kicker">click to focus</span>}
          />
          <RegionRanking active={region} onSelect={setRegion} />
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-4" delay={40}>
        <Panel className="h-full">
          <PanelHead
            title="Highest radiative power"
            hint="Strongest single detections in window"
            action={<Link href="/map" className="link-quiet">Map <ArrowRight size={11} className="inline" /></Link>}
          />
          <div className="fw-stagger divide-y divide-line/40">
            {hottest.loading ? <Loading label="Sorting detections" /> : null}
            {hottest.error ? <ErrorState error={hottest.error} /> : null}
            {hottest.data?.features.map((f) => (
              <Link
                key={f.properties.id}
                href={`/ask?lat=${f.properties.lat}&lon=${f.properties.lon}&obs=${encodeURIComponent(f.properties.id)}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-elevated/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", f.properties.sensor === "modis" ? "bg-cyan" : "bg-ember")} />
                    <p className="truncate font-mono text-[11px] text-ink">
                      {f.properties.lat.toFixed(2)}°, {f.properties.lon.toFixed(2)}°
                    </p>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[9.5px] text-muted">
                    {f.properties.satellite} · {f.properties.acqDate} {f.properties.acqTime}Z
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ConfidenceBadge value={f.properties.confidenceClass} />
                  <span className="value w-16 text-right text-[11.5px]">{formatNum(f.properties.frp, 1)} MW</span>
                </div>
              </Link>
            ))}
            {hottest.data && hottest.data.features.length === 0 ? (
              <EmptyState title="No detections" body="No stored detections match this region." />
            ) : null}
          </div>
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-4" delay={80}>
        <Panel className="h-full">
          <PanelHead title="Deviation from baseline" hint="Robust z-score against stored days" icon={<TrendingUp size={14} />} />
          <div className="space-y-3 p-4">
            {anomaly.loading ? <Loading label="Computing baseline" /> : null}
            {anomaly.error ? <ErrorState error={anomaly.error} /> : null}
            {anomaly.data && !anomaly.data.available ? (
              <EmptyState title="No baseline available" body={anomaly.data.reason ?? "Not enough stored days."} />
            ) : null}
            {anomaly.data?.available && anomaly.data.target ? (
              <>
                <div className="flex items-end justify-between">
                  <div>
                    <p className="kicker">Latest day</p>
                    <p className="value mt-1 text-[24px]">
                      <AnimatedNumber value={anomaly.data.target.count} fallback="—" />
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">{formatDate(anomaly.data.target.date)}</p>
                  </div>
                  <div className="text-right">
                    <p className="kicker">Robust z</p>
                    <p className={cn(
                      "value mt-1 text-[24px]",
                      (anomaly.data.deviation?.robustZ ?? 0) > 1.5 ? "text-ember"
                        : (anomaly.data.deviation?.robustZ ?? 0) < -1.5 ? "text-cyan" : "text-ink",
                    )}>
                      {anomaly.data.deviation?.robustZ ?? "n/a"}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {anomaly.data.quality?.baselineDays} baseline days
                    </p>
                  </div>
                </div>
                <div className="rounded-md border border-line/60 bg-elevated/30 p-2.5">
                  <p className="text-[11px] leading-relaxed text-muted">
                    {anomaly.data.quality?.note}
                  </p>
                </div>
                <Link href="/history" className="link-quiet inline-flex items-center gap-1">
                  Explore the distribution <ArrowUpRight size={11} />
                </Link>
              </>
            ) : null}
          </div>
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-8" delay={0}>
        <Panel className="h-full">
          <PanelHead
            title="Ask the Earth"
            hint="Point at a thermal anomaly, get an evidence-backed explanation"
            icon={<Crosshair size={14} />}
            action={<Link href="/ask" className="link-quiet">Open workspace <ArrowRight size={11} className="inline" /></Link>}
          />
          <div className="grid gap-3 p-4 md:grid-cols-3">
            {[
              { q: "What is this hotspot?", d: "Native metadata, FRP and confidence for a single detection." },
              { q: "Does MODIS see it too?", d: "Corroboration between a 1 km and a 375 m footprint." },
              { q: "Is this unusual?", d: "Robust deviation against the stored baseline, with sample size." },
            ].map((s) => (
              <Link
                key={s.q}
                href="/ask"
                className="group rounded-lg border border-line/70 bg-elevated/25 p-3 transition-colors hover:border-cyan/40 hover:bg-elevated/50"
              >
                <p className="text-[12.5px] font-medium text-ink">{s.q}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.d}</p>
                <span className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan/70 group-hover:text-cyan">
                  Try it <ArrowRight size={10} />
                </span>
              </Link>
            ))}
          </div>
        </Panel>
        </RevealSection>

        <RevealSection className="xl:col-span-4" delay={40}>
        <Panel className="h-full">
          <PanelHead title="Sensor mix" hint="Share of stored detections" />
          <div className="space-y-3 p-4">
            <SensorShare sensor="modis" count={regionSummary?.modis ?? 0} total={regionSummary?.total ?? 0} />
            <SensorShare sensor="viirs" count={regionSummary?.viirs ?? 0} total={regionSummary?.total ?? 0} />
            <div className="hairline" />
            <p className="text-[11px] leading-relaxed text-muted">
              These are shares of <span className="text-ink/80">stored detections in this window</span>,
              not shares of burning. VIIRS reports several times more detections than MODIS here
              because of its smaller footprint, greater sensitivity and more platforms/overpasses —
              that is not evidence it observed more of the same fires. See the{" "}
              <Link href="/harmonization" className="text-cyan/90 hover:text-cyan">harmonization lab</Link>.
            </p>
          </div>
        </Panel>
        </RevealSection>
      </section>

      <RevealSection as="section" aria-label="Platform surfaces" className="mt-3">
        <Panel>
          <PanelHead
            title="Where to go next"
            hint="Every surface below reads the same engine — no number is typed by hand"
            icon={<Compass size={14} />}
          />
          <div className="fw-stagger grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { href: "/map", title: "Fire map", body: "Every stored detection, clustered, filterable, with imagery and a day ledger." },
              { href: "/calendar", title: "Burning calendar", body: "Day-by-day coverage states, weekly/monthly/seasonal views, experimental intensity." },
              { href: "/harmonization", title: "Harmonization lab", body: "MODIS vs VIIRS density with confidence intervals and matched-pair comparison." },
              { href: "/history", title: "Historical explorer", body: "Stored window series, FRP distribution, baseline deviation with its sample size." },
              { href: "/intelligence", title: "Intelligence", body: "Evidence-grounded answers, deterministic by default, optional local model." },
              { href: "/ask", title: "Ask the Earth", body: "Pick a point on the globe; coverage verdict first, numbers second." },
              { href: "/reports", title: "Reports", body: "CSV and JSON exported from SQLite on request, with method and limits." },
              { href: "/settings", title: "Settings", body: "Theme, motion, model status, and the exact environment the engine reads." },
            ].map((l) => (
              <Link key={l.href} href={l.href}
                className="group rounded-lg border border-line/70 bg-elevated/25 p-3 transition-colors hover:border-cyan/40 hover:bg-elevated/50">
                <p className="flex items-center justify-between text-[12.5px] font-medium text-ink">
                  {l.title}
                  <ArrowUpRight size={11} className="text-muted transition-colors group-hover:text-cyan" />
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{l.body}</p>
              </Link>
            ))}
          </div>
        </Panel>
      </RevealSection>
    </div>
  );
}

function MiniKpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line/60 bg-elevated/30 px-2.5 py-2">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">{label}</p>
      <p className="value mt-1 text-[14px]">{value}</p>
    </div>
  );
}

function SensorShare({ sensor, count, total }: { sensor: "modis" | "viirs"; count: number; total: number }) {
  const pct = total ? (count / total) * 100 : 0;
  // The bar animates from zero width once, then follows the value with a
  // transition when the region changes.
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <SensorChip sensor={sensor} />
        <span className="value text-[11.5px]">
          <AnimatedNumber value={total ? count : null} fallback="—" /> · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elevated">
        <div
          className="fw-grow-x h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(pct, 0.6)}%`, background: SENSOR_COLOR[sensor] }}
        />
      </div>
    </div>
  );
}

function ActivityChart({ series }: { series: TimeseriesPoint[] }) {
  const t = useChartTokens();
  const modisMotion = useSeriesMotion(0);
  const viirsMotion = useSeriesMotion(1);
  return (
    <div className="h-[248px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="modisFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={t.cyan} stopOpacity={0.35} />
              <stop offset="100%" stopColor={t.cyan} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="viirsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={t.ember} stopOpacity={0.3} />
              <stop offset="100%" stopColor={t.ember} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={t.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickFormatter={(d: string) => d.slice(5)}
            axisLine={{ stroke: t.grid }}
            tickLine={false}
            minTickGap={18}
          />
          <YAxis
            tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v: number) => formatCompact(v)}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as TimeseriesPoint;
              return (
                <div className="rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</p>
                  {p.available ? (
                    <div className="mt-1.5 space-y-1">
                      <Row color={SENSOR_COLOR.modis} label="MODIS" value={`${formatInt(p.modis)} · ${formatCompact(p.modisFrp)} MW`} />
                      <Row color={SENSOR_COLOR.viirs} label="VIIRS" value={`${formatInt(p.viirs)} · ${formatCompact(p.viirsFrp)} MW`} />
                      <div className="mt-1 border-t border-line/60 pt-1">
                        <Row color={t.ink} label="Total" value={formatInt(p.total)} />
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted">No stored observations for this day.</p>
                  )}
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="modis"
            stroke={SENSOR_COLOR.modis}
            strokeWidth={1.6}
            fill="url(#modisFill)"
            name="MODIS"
            dot={false}
            activeDot={{ r: 3 }}
            {...modisMotion}
          />
          <Area
            type="monotone"
            dataKey="viirs"
            stroke={SENSOR_COLOR.viirs}
            strokeWidth={1.6}
            fill="url(#viirsFill)"
            name="VIIRS"
            dot={false}
            activeDot={{ r: 3 }}
            {...viirsMotion}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center gap-4 px-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full" style={{ background: SENSOR_COLOR.modis }} /> MODIS</span>
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full" style={{ background: SENSOR_COLOR.viirs }} /> VIIRS</span>
        <span className="ml-auto normal-case tracking-normal text-muted/70">Days without coverage are absent, not zero.</span>
      </div>
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[11px]">
      <span className="flex items-center gap-1.5 text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="value text-[11px]">{value}</span>
    </div>
  );
}

function RegionRanking({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  // One global aggregation call, bucketed into the named study regions on the
  // client. Eleven per-region summary queries would each scan the store.
  const { data, loading } = useApi<{ cells: Cell[] }>("/api/cells", { region: "global", cell: 3 });

  const rows = useMemo(() => {
    const cells = data?.cells ?? [];
    return REGIONS.filter((r) => r.id !== "global")
      .map((r) => {
        const [w, s, e, n] = r.bbox;
        let count = 0;
        let modis = 0;
        let viirs = 0;
        for (const c of cells) {
          if (c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n) {
            count += c.count;
            modis += c.modis;
            viirs += c.viirs;
          }
        }
        return { id: r.id, name: r.name, count, modis, viirs };
      })
      .sort((a, b) => b.count - a.count);
  }, [data]);

  if (loading) return <Loading label="Ranking study regions" />;

  const total = rows.reduce((s, x) => s + x.count, 0) || 1;

  return (
    <div className="fw-stagger divide-y divide-line/40">
      {rows.slice(0, 6).map((r, i) => (
        <button
          key={r.id}
          onClick={() => onSelect(r.id)}
          className={cn(
            "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-elevated/40",
            active === r.id && "bg-cyan/5",
          )}
        >
          <span className="w-4 font-mono text-[10px] text-muted/60">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[12px] text-ink">{r.name}</p>
              <p className="value text-[11.5px]">{formatInt(r.count)}</p>
            </div>
            <div className="fw-grow-x mt-1.5 flex h-1 overflow-hidden rounded-full bg-elevated"
              style={{ "--fw-delay": `${i * 70}ms` } as React.CSSProperties}>
              <span style={{ width: `${(r.modis / (r.count || 1)) * 100}%`, background: SENSOR_COLOR.modis }} />
              <span style={{ width: `${(r.viirs / (r.count || 1)) * 100}%`, background: SENSOR_COLOR.viirs }} />
            </div>
          </div>
          <span className="w-10 text-right font-mono text-[10px] text-muted">
            {((r.count / total) * 100).toFixed(1)}%
          </span>
        </button>
      ))}
      <div className="flex items-center justify-between px-4 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted/60">
        <span>3° cell aggregation</span>
        <span>share of these regions' stored detections</span>
      </div>
    </div>
  );
}

function EarthView({ date }: { date: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [imgDate, setImgDate] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/imagery/latest${date ? `?prefer=${date}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { src: string | null; date: string | null; note: string | null; requested: string }) => {
        if (!alive) return;
        setSrc(d.src);
        setImgDate(d.date);
        setNote(d.note ?? (d.date !== d.requested ? `Imagery lags the fire feed — showing ${d.date}.` : null));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [date]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-line/70 bg-void">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_45%,rgba(57,200,242,0.18),transparent_55%)]" />
      {src ? (
        /* NASA GIBS true-colour imagery — the latest date GIBS actually publishes. */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={`NASA VIIRS true-colour imagery for ${imgDate}`}
          className="h-[210px] w-full object-cover opacity-95 sm:h-[248px]"
          loading="lazy"
        />
      ) : (
        <div className="h-[210px] w-full animate-pulse bg-gradient-to-b from-elevated/40 to-transparent sm:h-[248px]" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-void via-void/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-cyan/80">
            Reference imagery · not a live fire view
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink/90">
            {imgDate ? formatDate(imgDate) : "loading imagery"} · NASA GIBS VIIRS true colour
          </p>
          {note ? <p className="mt-0.5 max-w-[240px] truncate font-mono text-[9px] text-muted/80">{note}</p> : null}
        </div>
        <Link href="/map" className="btn shrink-0 px-2 py-1 text-[10.5px]">
          <Globe2 size={11} /> Map
        </Link>
      </div>
    </div>
  );
}
