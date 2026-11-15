"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  CartesianGrid, Cell as RCell, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, Bar, BarChart,
} from "recharts";
import { AlertTriangle, ArrowRight, GitCompareArrows, Info, Scale, Sigma } from "lucide-react";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { useFilters } from "@/components/shell/FiltersProvider";
import { useChartMotion } from "@/components/motion";
import { useChartTokens } from "@/lib/theme";
import { REGION_MAP } from "@/lib/regions";
import {
  Badge, DataNotice, EmptyState, ErrorState, KeyValue, Loading, Panel, PanelHead, SectionTitle, Segmented, SensorChip,
} from "@/components/ui/primitives";
import { SENSOR_COLOR, cn, formatInt, formatNum } from "@/lib/format";
import type { Comparison, Harmonization, HarmonizationV2 } from "@/lib/types";

export default function HarmonizationPage() {
  const t = useChartTokens();
  const chartMotion = useChartMotion();
  const { region } = useFilters();
  const [grid, setGrid] = useState(0.25);
  const [sensitivity, setSensitivity] = useState(false);
  const { data, error, loading } = useApi<Harmonization>("/api/harmonization",
    { region, grid, sensitivity }, [grid, sensitivity]);
  // Phase 2 engine, loaded alongside the legacy view so first paint stays fast.
  const { data: v2, error: v2Error } = useApi<HarmonizationV2>("/api/harmonization/v2",
    { region, grid, sensitivity }, [grid, sensitivity, region]);
  const { data: matched, error: matchedError } = useApi<Comparison>("/api/comparison",
    { region }, [region]);
  const name = REGION_MAP[region]?.name ?? "Global";

  const scatter = useMemo(() => {
    return (data?.pairedSample ?? [])
      .filter((p) => p.modisFrp > 0 && p.viirsFrp > 0)
      .map((p) => ({ ...p, x: p.viirsFrp, y: p.modisFrp }));
  }, [data]);

  const distribution = useMemo(() => {
    if (!data) return [];
    const m = data.sensors.modis.frp;
    const v = data.sensors.viirs.frp;
    return [
      { band: "median", modis: m.median ?? 0, viirs: v.median ?? 0 },
      { band: "p90", modis: m.p90 ?? 0, viirs: v.p90 ?? 0 },
      { band: "mean", modis: m.mean ?? 0, viirs: v.mean ?? 0 },
      { band: "max", modis: m.max ?? 0, viirs: v.max ?? 0 },
    ];
  }, [data]);

  if (loading) return <Loading label="Comparing sensor footprints" />;
  if (error) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (!data || data.sensors.modis.detections + data.sensors.viirs.detections === 0) {
    return (
      <Panel>
        <EmptyState
          title="No overlapping data for this region"
          body="Neither sensor has stored detections in the selected area. Choose another region to run the comparison."
        />
      </Panel>
    );
  }

  const { hfai, sensors, window: win } = data;
  const bothShare = Math.round(hfai.coincidentShare * 1000) / 10;

  return (
    <div className="fw-stagger space-y-4">
      <Panel className="overflow-hidden">
        <div className="relative grid gap-5 p-5 lg:grid-cols-[1.3fr_1fr]">
          <div className="absolute inset-0 grid-bg opacity-40" />
          <div className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="cyan"><GitCompareArrows size={10} /> {name}</Badge>
              <Badge tone="warn">experimental metric</Badge>
              <Badge tone="muted">{win.overlapDays} overlapping days</Badge>
            </div>
            <h2 className="mt-3 text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              Two instruments, two footprints, one burning landscape
            </h2>
            <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-muted">
              MODIS resolves 1 km pixels; VIIRS resolves 375 m and flies on three platforms. Raw counts
              therefore cannot be compared. Here both are reduced to 0.25° cell-days, repeated overpasses are
              suppressed with a per-cell maximum, and the comparison is made on a physical quantity with an
              explicit sample size and interval.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Grid</span>
              <Segmented
                size="sm"
                value={String(grid)}
                onChange={(v) => setGrid(Number(v))}
                options={[
                  { value: "0.1", label: "0.1°" },
                  { value: "0.25", label: "0.25°" },
                  { value: "0.5", label: "0.5°" },
                ]}
              />
              <button
                type="button"
                onClick={() => setSensitivity((v) => !v)}
                className={cn("btn px-2 py-1 text-[11px]", sensitivity ? "btn-primary" : "btn-ghost")}
              >
                {sensitivity ? "Hide" : "Show"} grid sensitivity
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniStat label="MODIS det." value={formatInt(sensors.modis.detections)} color={SENSOR_COLOR.modis} />
              <MiniStat label="VIIRS det." value={formatInt(sensors.viirs.detections)} color={SENSOR_COLOR.viirs} />
              <MiniStat label="Paired cell-days" value={formatInt(hfai.pairedCellDays)} />
              <MiniStat label="Co-detection" value={`${bothShare}%`} />
            </div>
          </div>

          <div className="relative rounded-xl border border-ember/25 bg-ember/[0.04] p-4">
            <div className="flex items-center justify-between">
              <p className="kicker text-ember/80">HFAI-v1 · experimental</p>
              <Sigma size={14} className="text-ember/70" />
            </div>
            <p className="mt-2 flex items-baseline gap-1.5">
              <span className="value text-[30px] leading-none text-ink">{formatNum(hfai.combinedDensity, 4)}</span>
              <span className="font-mono text-[11px] text-muted">MW km⁻² day⁻¹</span>
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Combined FRP per km² of active burning area per day, across {formatInt(hfai.cellDays)} cell-days.
            </p>
            <div className="mt-3 space-y-1">
              <KeyValue label="MODIS density" value={`${formatNum(hfai.modisDensity, 4)}`} />
              <KeyValue label="VIIRS density" value={`${formatNum(hfai.viirsDensity, 4)}`} />
              <KeyValue
                label="MODIS / VIIRS FRP ratio"
                value={hfai.modisToViirsRatio ? hfai.modisToViirsRatio.toFixed(3) : "not estimable"}
              />
              <KeyValue
                label="95% bootstrap CI"
                value={hfai.ratioCi95 ? `[${hfai.ratioCi95[0]}, ${hfai.ratioCi95[1]}]` : "—"}
              />
              <KeyValue label="Active area" value={`${formatInt(hfai.activeAreaKm2)} km²`} />
              {hfai.densityCi95 ? (
                <KeyValue
                  label="Combined 95% CI"
                  value={`${formatNum(hfai.densityCi95[0], 5)} – ${formatNum(hfai.densityCi95[1], 5)}`}
                />
              ) : null}
            </div>
            {/* The page used to render two independent HFAI computations under
                the same label. They now come from one code path; saying so is
                the only way a reader can trust that the two panels agree. */}
            <p className="mt-2 font-mono text-[9px] leading-relaxed text-muted/60">
              same indicator as the grid panel below · {hfai.provenance ?? "harmonize.indicator"}
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-7">
          <PanelHead
            title="Paired cell-day FRP"
            hint="Each dot is one 0.25° cell-day seen by both sensors · log–log"
            action={<Badge tone="muted">{scatter.length} sampled</Badge>}
          />
          <div className="p-3">
            {scatter.length < 8 ? (
              <EmptyState
                title="Not enough paired cell-days"
                body="A ratio is not reported until at least eight cells are observed by both instruments on the same day."
              />
            ) : (
              <div className="h-[320px] w-full">
                <ResponsiveContainer>
                  <ScatterChart margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke={t.grid} strokeDasharray="2 4" />
                    <XAxis
                      type="number" dataKey="x" scale="log" domain={[0.1, "auto"]} allowDataOverflow
                      name="VIIRS FRP" unit=" MW"
                      tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }}
                      axisLine={{ stroke: t.grid }} tickLine={false}
                      label={{ value: "VIIRS cell FRP (MW, log)", position: "insideBottom", offset: -4, fill: t.axis, fontSize: 10 }}
                    />
                    <YAxis
                      type="number" dataKey="y" scale="log" domain={[0.1, "auto"]} allowDataOverflow
                      name="MODIS FRP" unit=" MW" width={48}
                      tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }}
                      axisLine={false} tickLine={false}
                      label={{ value: "MODIS (MW, log)", angle: -90, position: "insideLeft", fill: t.axis, fontSize: 10 }}
                    />
                    <ReferenceLine segment={[{ x: 0.1, y: 0.1 }, { x: 5000, y: 5000 }]} stroke={t.ok} strokeDasharray="4 4" strokeOpacity={0.4} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as { lat: number; lon: number; day: string; modisFrp: number; viirsFrp: number };
                        return (
                          <div className="rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-xl">
                            <p className="font-mono text-[10px] text-muted">{p.lat}°, {p.lon}° · {p.day}</p>
                            <p className="mt-1 font-mono text-[11px] text-cyan">MODIS {formatNum(p.modisFrp, 2)} MW</p>
                            <p className="font-mono text-[11px] text-ember">VIIRS {formatNum(p.viirsFrp, 2)} MW</p>
                          </div>
                        );
                      }}
                    />
                    <Scatter
                      data={scatter}
                      fill={SENSOR_COLOR.viirs}
                      fillOpacity={0.5}
                      shape="circle"
                      isAnimationActive={chartMotion.isAnimationActive}
                      animationDuration={chartMotion.animationDuration}
                      animationBegin={chartMotion.animationBegin}
                      animationEasing={chartMotion.animationEasing}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="px-2 pb-1 text-[10.5px] leading-relaxed text-muted">
              Points above the green line report more FRP in MODIS than in VIIRS for the same cell-day: the
              coarser pixel integrates more of the fire. The cloud is visibly offset upward, which is the effect
              the harmonized metric has to respect rather than erase.
            </p>
          </div>
        </Panel>

        <Panel className="xl:col-span-5">
          <PanelHead title="FRP distribution by sensor" hint="Reported MW per detection" />
          <div className="h-[210px] w-full p-2">
            <ResponsiveContainer>
              <BarChart data={distribution} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={t.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="band" tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={{ stroke: t.grid }} tickLine={false} />
                <YAxis tick={{ fill: t.axis, fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: t.axis, fontFamily: "var(--font-mono)", fontSize: 10 }}
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
                  animationBegin={chartMotion.animationBegin + 110}
                  animationEasing={chartMotion.animationEasing} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-2 px-4 pb-4">
            <SectionTitle>Native fields, not converted</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <ConfidenceDonut label="MODIS" data={sensors.modis.confidence} accent={SENSOR_COLOR.modis} />
              <ConfidenceDonut label="VIIRS" data={sensors.viirs.confidence} accent={SENSOR_COLOR.viirs} />
            </div>
            <DataNotice>
              MODIS confidence is a percentage; VIIRS confidence is low / nominal / high. The class view is a
              display convenience, never a calibration.
            </DataNotice>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHead title="Side-by-side sensor profile" hint={`${name} · ${win.start ?? "all"} → ${win.end ?? "all"}`} icon={<Scale size={14} />} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-line/70 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
                <th className="px-4 py-2.5 font-normal">Property</th>
                <th className="px-4 py-2.5 font-normal text-cyan/80">MODIS C6.1</th>
                <th className="px-4 py-2.5 font-normal text-ember/80">VIIRS 375 m</th>
                <th className="px-4 py-2.5 font-normal">Why it matters</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/40">
              {[
                ["Detections", formatInt(sensors.modis.detections), formatInt(sensors.viirs.detections), "Raw counts are dominated by footprint and overpass count."],
                ["Detections / 1,000 km²", formatNum(sensors.modis.detectionsPer1000Km2, 2), formatNum(sensors.viirs.detectionsPer1000Km2, 2), "Still resolution-dependent, but normalizes region size."],
                ["Median FRP (MW)", formatNum(sensors.modis.frp.median, 2), formatNum(sensors.viirs.frp.median, 2), "A coarser pixel integrates more fire per detection."],
                ["Mean FRP (MW)", formatNum(sensors.modis.frp.mean, 2), formatNum(sensors.viirs.frp.mean, 2), "Sensitive to a few very large fires."],
                ["p90 FRP (MW)", formatNum(sensors.modis.frp.p90, 2), formatNum(sensors.viirs.frp.p90, 2), "Upper tail of fire intensity."],
                ["Pixel area", "1.00 km²", "0.1406 km²", "The physical reason the two sensors disagree."],
                ["Platforms", Object.keys(sensors.modis.satellites).join(", ") || "—", Object.keys(sensors.viirs.satellites).join(", ") || "—", "More platforms means more overpass opportunities."],
                ["High-confidence share", `${Math.round((sensors.modis.confidence.high ?? 0) * 100)}%`, `${Math.round((sensors.viirs.confidence.high ?? 0) * 100)}%`, "Different confidence semantics — compare cautiously."],
              ].map((row) => (
                <tr key={row[0]} className="transition-colors hover:bg-elevated/25">
                  <td className="px-4 py-2.5 text-muted">{row[0]}</td>
                  <td className="px-4 py-2.5 font-mono text-ink/90">{row[1]}</td>
                  <td className="px-4 py-2.5 font-mono text-ink/90">{row[2]}</td>
                  <td className="px-4 py-2.5 text-[11px] text-muted/90">{row[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel>
        <PanelHead title="Methods ladder" hint="What each number is, and how far it can be trusted" icon={<Info size={14} />} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-line/60 font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
                <th className="px-4 py-2">step</th>
                <th className="px-4 py-2">quantity</th>
                <th className="px-4 py-2">unit</th>
                <th className="px-4 py-2">value</th>
                <th className="px-4 py-2">status</th>
              </tr>
            </thead>
            <tbody>
              {(data.methods ?? []).map((m) => (
                <tr key={m.id} className="border-b border-line/40 align-top last:border-0">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-cyan">{m.id}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-[12px] text-ink">{m.name}</p>
                    <p className="mt-0.5 max-w-md text-[10.5px] leading-snug text-muted">{m.note}</p>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-muted">{m.unit}</td>
                  <td className="px-4 py-2.5 font-mono text-[10.5px] tabular-nums text-ink">
                    {Object.entries(m.value).map(([k, v]) => (
                      <span key={k} className="mr-2 inline-block">
                        <span className="text-muted">{k} </span>
                        {typeof v === "number" ? formatNum(v, 3) : String(v ?? "—")}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={m.status === "experimental" ? "warn" : m.status === "derived" ? "cyan" : "ok"}>
                      {m.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.hfaiV2 && (
          <div className="border-t border-line/60 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warn">HFAI-v2 · experimental</Badge>
              <span className="font-mono text-[10px] text-muted">{data.hfaiV2.pairedCellDays} paired cell-days</span>
            </div>
            <p className="mt-2 max-w-3xl text-[11.5px] leading-relaxed text-muted">{data.hfaiV2.note}</p>
            <div className="mt-2 grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <KeyValue label="MODIS mean" value={`${formatNum(data.hfaiV2.modisMeanFrp, 2)} MW`} />
              <KeyValue label="VIIRS mean" value={`${formatNum(data.hfaiV2.viirsMeanFrp, 2)} MW`} />
              <KeyValue label="ratio" value={data.hfaiV2.ratio?.toFixed(3) ?? "—"} />
              <KeyValue label="validation" value="none in this build" />
            </div>
          </div>
        )}
        {sensitivity && data.gridSensitivity && (
          <div className="border-t border-line/60 p-4">
            <SectionTitle right={<span className="font-mono text-[9px] text-muted">same data, three grids</span>}>
              Grid sensitivity
            </SectionTitle>
            <div className="grid gap-2 sm:grid-cols-3">
              {data.gridSensitivity.map((row) => (
                <div key={row.grid} className={cn("rounded-lg border p-3",
                  row.grid === grid ? "border-cyan/50 bg-cyan/5" : "border-line/70 bg-elevated/20")}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{row.grid}° cells</p>
                  <p className="mt-1 font-mono text-[18px] tabular-nums text-ink">{formatNum(row.combinedDensity, 4)}</p>
                  <p className="font-mono text-[9px] text-muted">MW km⁻² day⁻¹</p>
                  <p className="mt-1.5 font-mono text-[9.5px] text-muted">
                    {formatInt(row.activeCells)} cells · ratio {row.ratio?.toFixed(3) ?? "—"}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted">
              Density changes with grid size because the active-area denominator changes. Report the grid with
              the number; never compare densities computed on different grids.
            </p>
          </div>
        )}
      </Panel>

      {v2Error && (
        <DataNotice>
          The sensor-separation engine did not answer ({v2Error}). The figures above are unaffected;
          these two panels are additional evidence, and nothing is shown in their place rather than an
          empty card that could be read as zero.
        </DataNotice>
      )}
      {matchedError && (
        <DataNotice>
          The matched-detection comparison did not answer ({matchedError}), so no tolerance table is shown.
        </DataNotice>
      )}

      {v2 && (
        <Panel>
          <PanelHead
            title="Sensor separation"
            hint={`${v2.selected.grid}° cells · exact spherical cell area · ${v2.selected.combined.daysUsed} delivery days`}
            icon={<Scale size={14} />}
            action={<Badge tone="warn">{v2.validationStatus.replaceAll("_", " ")}</Badge>}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {(["modis", "viirs"] as const).map((s) => {
              const m = v2.selected.sensors[s];
              return (
                <div key={s} className="rounded-lg border border-line/70 bg-elevated/20 p-3">
                  <SensorChip sensor={s} />
                  <p className="mt-2 font-mono text-[24px] leading-none tabular-nums text-ink">
                    {formatNum(m.density, 5)}
                  </p>
                  <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">MW km⁻² day⁻¹</p>
                  <div className="mt-2 space-y-0.5">
                    <KeyValue label="95% CI" value={m.densityCi95
                      ? `${formatNum(m.densityCi95[0], 5)} – ${formatNum(m.densityCi95[1], 5)}`
                      : "not reported (<12 cell-days)"} />
                    <KeyValue label="active area" value={`${formatInt(m.activeAreaKm2)} km²`} />
                    <KeyValue label="cell-days" value={formatInt(m.cellDays)} />
                    <KeyValue label="Σ max FRP" value={`${formatInt(m.frpTotalMw)} MW`} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-line/60 p-4">
            <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <KeyValue label="combined" value={`${formatNum(v2.selected.combined.density, 5)} MW km⁻²`} />
              <KeyValue label="combined CI" value={v2.selected.combined.densityCi95
                ? `${formatNum(v2.selected.combined.densityCi95[0], 5)} – ${formatNum(v2.selected.combined.densityCi95[1], 5)}`
                : "—"} />
              <KeyValue label="paired cell-days" value={formatInt(v2.selected.hfaiV2.pairedCellDays)} />
              <KeyValue label="spearman ρ" value={v2.selected.hfaiV2.spearmanRho?.toFixed(3) ?? "—"} />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <KeyValue label="MODIS-only cell-days" value={formatInt(v2.selected.disagreement.modisOnlyCellDays)} />
              <KeyValue label="VIIRS-only cell-days" value={formatInt(v2.selected.disagreement.viirsOnlyCellDays)} />
              <KeyValue label="cell Jaccard" value={v2.selected.disagreement.jaccardCells?.toFixed(3) ?? "—"} />
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted">{v2.selected.disagreement.interpretation}</p>
          </div>
        </Panel>
      )}

      {matched && matched.matching.detail.pairs > 0 && (
        <Panel>
          <PanelHead
            title="Matched detections"
            hint={`${matched.matching.primaryKm} km · ${matched.matching.primaryHours} h · one-to-one greedy`}
            icon={<GitCompareArrows size={14} />}
            action={<Badge tone="muted">descriptive</Badge>}
          />
          <div className="p-4">
            <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <KeyValue label="pairs" value={formatInt(matched.matching.detail.pairs)} />
              <KeyValue label="median distance" value={`${matched.matching.detail.medianDistanceKm.toFixed(2)} km`} />
              <KeyValue label="MODIS matched" value={`${(matched.matching.detail.modisMatchedShare * 100).toFixed(1)}%`} />
              <KeyValue label="VIIRS matched" value={`${(matched.matching.detail.viirsMatchedShare * 100).toFixed(1)}%`} />
              <KeyValue label="FRP ratio" value={matched.matching.detail.frpRatio?.toFixed(3) ?? "—"} />
              <KeyValue label="ratio CI" value={matched.matching.detail.frpRatioCi95
                ? `[${matched.matching.detail.frpRatioCi95[0]}, ${matched.matching.detail.frpRatioCi95[1]}]`
                : "—"} />
              <KeyValue label="KS D" value={matched.frpDistribution.statistic?.toFixed(3) ?? "—"} />
              <KeyValue label="same-fire claim" value="none" />
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted">
                    <th className="py-1 pr-3">tolerance</th>
                    <th className="py-1 pr-3 text-right">pairs</th>
                    <th className="py-1 pr-3 text-right">MODIS matched</th>
                    <th className="py-1 pr-3 text-right">median km</th>
                    <th className="py-1 text-right">median ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {matched.matching.settings.filter((r) => r.pairs > 0).map((r) => (
                    <tr key={`${r.maxKm}-${r.windowHours}`} className="border-t border-line/40 font-mono text-[10px]">
                      <td className="py-1 pr-3 text-muted">{r.maxKm} km · {r.windowHours} h</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-ink/85">{formatInt(r.pairs)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted">
                        {r.modisMatchedShare == null ? "—" : `${(r.modisMatchedShare * 100).toFixed(0)}%`}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted">{r.medianDistanceKm?.toFixed(2) ?? "—"}</td>
                      <td className="py-1 text-right tabular-nums text-ink/85">{r.medianFrpRatio?.toFixed(2) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted">{matched.matching.rules}</p>
          </div>
        </Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHead title="Method" hint="Reproducible, documented, and limited" icon={<Info size={14} />} />
          <div className="space-y-3 p-4">
            <p className="text-[12px] leading-relaxed text-muted">{hfai.method}</p>
            <div className="rounded-lg border border-line/70 bg-elevated/25 p-3 font-mono text-[11px] leading-relaxed text-ink/85">
              <p>HFAI-v1 = Σ max(FRP_M, FRP_V) / (A_active · days)</p>
              <p className="mt-1 text-muted">FRP in MW · A_active in km² of 0.25° cells that reported</p>
              <p className="mt-1 text-muted">ratio = 10^mean(log10 FRP_M − log10 FRP_V) on paired cell-days</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warn">status: {hfai.status}</Badge>
              <Badge tone="muted">{hfai.pairedCellDays} paired cell-days</Badge>
              <Badge tone="muted">{formatInt(hfai.activeCells)} active cells</Badge>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Known limitations" hint="Read before quoting any number" icon={<AlertTriangle size={14} />} />
          <ol className="list-decimal space-y-2 p-4 pl-8 text-[11.5px] leading-relaxed text-muted">
            {data.limitations.map((l) => <li key={l}>{l}</li>)}
          </ol>
          <div className="px-4 pb-4">
            <Link href="/calendar" className="link-quiet inline-flex items-center gap-1">
              Continue to the burning activity calendar <ArrowRight size={11} />
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-line/70 bg-panel/60 px-3 py-2">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">{label}</p>
      <p className="value mt-1 flex items-center gap-1.5 text-[15px]" style={color ? { color } : undefined}>
        {color ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} /> : null}
        {value}
      </p>
    </div>
  );
}

function ConfidenceDonut({ label, data, accent }: { label: string; data: Record<string, number>; accent: string }) {
  const t = useChartTokens();
  const rows = [
    { key: "high", value: data.high ?? 0, color: t.ok },
    { key: "nominal", value: data.nominal ?? 0, color: accent },
    { key: "low", value: data.low ?? 0, color: t.muted },
    { key: "unclassified", value: data.unclassified ?? 0, color: t.grid },
  ].filter((r) => r.value > 0);
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  let acc = 0;
  return (
    <div className="rounded-lg border border-line/60 bg-elevated/25 p-2.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">{label}</p>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface">
        {rows.map((r) => {
          const w = (r.value / total) * 100;
          acc += w;
          return <span key={r.key} style={{ width: `${w}%`, background: r.color }} />;
        })}
      </div>
      <div className="mt-2 space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between font-mono text-[9.5px]">
            <span className="flex items-center gap-1 text-muted">
              <span className="h-1 w-1 rounded-full" style={{ background: r.color }} />{r.key}
            </span>
            <span className={cn("text-ink/80")}>{Math.round((r.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
