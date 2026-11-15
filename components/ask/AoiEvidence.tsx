"use client";

/**
 * AoiEvidence — everything the page can say about the selected point/area.
 *
 * Every value is an engine response for the AOI (see `useAoiData` for the
 * request contract). Nothing here is computed on a coordinate the engine has not
 * seen, and no number is displayed from a constant.
 *
 * The order of the panel is deliberate: verdict first, counts second. A reader
 * must learn whether the area was *observed* before reading any detection count,
 * because "0 detections" and "no coverage" are different scientific statements.
 */

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowUpRight, BookOpen, CalendarDays, ChevronRight, Flame, Info,
  Layers, Loader2, MapPin, RefreshCw, Satellite, Sparkles, Target,
} from "lucide-react";
import { useApi, useMeta } from "@/lib/hooks";
import { bboxAreaKm2, formatBbox, formatLat, formatLatLon, formatLon } from "@/lib/globe";
import { cn, formatArea, formatInt, formatNum } from "@/lib/format";
import { displayModelName } from "@/lib/model-label";
import {
  Badge, ConfidenceBadge, ErrorState, SensorChip, SkeletonRows,
} from "@/components/ui/primitives";
import type { DayDetail, Sensor } from "@/lib/types";
import { classifyAoi, VERDICT_TONE, windowDays, type AoiVerdict, type CalendarDayLike } from "./coverage";
import { useAoiData } from "./useAoiData";

interface Props {
  lat: number;
  lon: number;
  radiusKm: number;
  /** Explicit AOI. When absent, derived from lat/lon/radius by the caller. */
  bbox: [number, number, number, number];
  onPick: (lat: number, lon: number) => void;
  className?: string;
}

const SENSORS: Sensor[] = ["modis", "viirs"];

const STATE_TONE: Record<string, string> = {
  observed: "border-ember/40 bg-ember/10 text-ember",
  observed_zero: "border-ok/35 bg-ok/10 text-ok",
  partial: "border-cyan/35 bg-cyan/10 text-cyan",
  unknown: "border-line bg-elevated/40 text-muted",
  unavailable: "border-line bg-elevated/40 text-muted",
};

const STATE_SHORT: Record<string, string> = {
  observed: "detections",
  observed_zero: "confirmed zero",
  partial: "partial",
  unknown: "unknown",
  unavailable: "unavailable",
};

const VERDICT_RING: Record<AoiVerdict, string> = {
  detections: "border-ember/35 bg-ember/[0.05]",
  "confirmed-zero": "border-ok/30 bg-ok/[0.05]",
  partial: "border-cyan/30 bg-cyan/[0.04]",
  unknown: "border-line/70 bg-elevated/25",
  unavailable: "border-line/70 bg-elevated/25",
};

export function AoiEvidence({ lat, lon, radiusKm, bbox, onPick, className }: Props) {
  const { meta } = useMeta();
  const bboxStr = formatBbox(bbox);
  const data = useAoiData({ bbox: bboxStr, lat, lon, radiusKm, hours: 240 });

  const first = data.coverage?.coverage.first ?? meta?.coverage.first ?? null;
  const last = data.coverage?.coverage.last ?? meta?.coverage.last ?? null;

  const likes: CalendarDayLike[] = data.calendar
    ? windowDays(data.calendar.days, first, last).map((d) => ({
        date: d.date,
        state: d.state,
        available: d.available,
        total: d.total ?? null,
        sensors: d.sensors as unknown as CalendarDayLike["sensors"],
      }))
    : [];

  const lastDelivered = [...likes].reverse().find((d) => d.available);
  // Calendar is enrichment, not a precondition: without it the verdict degrades to
  // COVERAGE UNKNOWN (no day has delivery evidence we could read) while the real
  // summary numbers still render.
  const ready = Boolean(data.coverage && data.summary);
  const verdict = classifyAoi({
    totalDetections: data.summary?.totalDetections ?? 0,
    windowDays: likes,
    coverageFirst: first,
    coverageLast: last,
    dayEvidence: lastDelivered?.sensors
      ? Object.fromEntries(
          Object.entries(lastDelivered.sensors).map(([k, v]) => [k, { evidence: v?.evidence }]),
        )
      : null,
  });

  return (
    <div className={cn("space-y-3", className)}>
      {/* ------------------------------------------------------------ verdict */}
      {data.error ? <ErrorState error={data.error} /> : null}

      {!ready && !data.error ? (
        <section className="rounded-lg border border-line/70 bg-panel px-3.5 py-3">
          <p className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
            <Loader2 size={10} className="animate-spin text-cyan" />
            {data.step ? `querying ${data.step}` : "querying the engine"}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted/80">
            Coverage is resolved before counts: the engine answer for this AOI arrives in
            sequence, not as one atomic payload.
          </p>
          <div className="mt-3">
            <SkeletonRows rows={3} />
          </div>
        </section>
      ) : null}

      {ready ? (
        <section className={cn("rounded-lg border p-4", VERDICT_RING[verdict.verdict])}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="kicker">Area verdict · {first ?? "—"} → {last ?? "—"}</p>
              <h3 className="mt-1.5 text-[15px] font-semibold tracking-[-0.005em] text-ink">
                {verdict.label}
              </h3>
            </div>
            <Badge tone={VERDICT_TONE[verdict.verdict]}>coverage</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-[11.5px] leading-relaxed text-muted">{verdict.detail}</p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line/50 pt-2.5 sm:grid-cols-4">
            <Field label="Centre" value={formatLatLon(lat, lon, 3)} />
            <Field label="Radius" value={`${radiusKm} km`} />
            <Field label="AOI area" value={formatArea(bboxAreaKm2(bbox))} />
            <Field label="Detections in AOI" value={formatInt(data.summary?.totalDetections ?? 0)} />
          </dl>
          <p className="mt-2 font-mono text-[9.5px] text-muted/80">
            bbox {bboxStr} · W,S,E,N · {data.summary?.dataDays.length ?? 0} day
            {(data.summary?.dataDays.length ?? 0) === 1 ? "" : "s"} with detections
            {data.summary?.dataDays.length
              ? ` · ${data.summary.dataDays.join(", ")}`
              : ""}
          </p>

          {verdict.evidence.length ? (
            <ul className="mt-2 space-y-1 rounded border border-line/50 bg-void/40 p-2">
              {verdict.evidence.map((e) => (
                <li key={e} className="font-mono text-[9.5px] leading-relaxed text-muted/90">{e}</li>
              ))}
            </ul>
          ) : null}

          {data.step ? (
            <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-cyan/70">
              <Loader2 size={9} className="animate-spin" /> updating · {data.step}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ------------------------------------------------------- sensor table */}
      {data.summary ? (
        <section className="rounded-lg border border-line/70 bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3.5 py-2.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
              <Satellite size={11} /> Detections by sensor &amp; platform
            </span>
            <span className="font-mono text-[9px] text-muted/70">FRP · native confidence</span>
          </div>
          <div className="divide-y divide-line/40">
            {SENSORS.map((sensor) => {
              const s = data.summary?.sensors[sensor];
              if (!s) return null;
              const platforms = Object.entries(s.satellites ?? {});
              return (
                <div key={sensor} className="px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SensorChip sensor={sensor} count={s.detections} />
                    <span className="font-mono text-[9.5px] text-muted/80">
                      {platforms.length
                        ? platforms.map(([name, n]) => `${name} ${formatInt(n)}`).join(" · ")
                        : "no detection in this AOI"}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <Field label="Median FRP" value={fmtMw(s.frp.median)} />
                    <Field label="P90 FRP" value={fmtMw(s.frp.p90)} />
                    <Field label="Max FRP" value={fmtMw(s.frp.max)} />
                    <Field label="FRP sum" value={fmtMw(s.frp.sum)} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted/60">
                      confidence
                    </span>
                    {(["high", "nominal", "low", "unclassified"] as const).map((cls) =>
                      s.confidence[cls] ? (
                        <span key={cls} className="inline-flex items-center gap-1">
                          <ConfidenceBadge value={cls} />
                          <span className="font-mono text-[9.5px] text-muted/80">
                            {formatInt(s.confidence[cls])}
                          </span>
                        </span>
                      ) : null,
                    )}
                    <span className="font-mono text-[9px] text-muted/60">
                      · {s.dayDetections} day / {s.nights} night
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="border-t border-line/40 px-3.5 py-2 text-[10px] leading-relaxed text-muted/80">
            Native confidence is preserved, not converted: MODIS reports a 0–100% retrieval
            confidence, VIIRS an ordinal low/nominal/high category. The shared class above is a
            display view only and is never used to compare the two sensors.
          </p>
        </section>
      ) : null}

      {/* -------------------------------------------------------- strongest */}
      {data.observations?.features.length ? (
        <section className="rounded-lg border border-line/70 bg-panel">
          <div className="flex items-center justify-between gap-2 border-b border-line/60 px-3.5 py-2.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
              <Flame size={11} /> Strongest detections in the AOI
            </span>
            <span className="font-mono text-[9px] text-muted/70">by FRP · UTC</span>
          </div>
          <div className="divide-y divide-line/40">
            {data.observations.features.map((f) => {
              const p = f.properties;
              return (
                <button
                  key={p.id}
                  onClick={() => onPick(p.lat, p.lon)}
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-elevated/40"
                  title={`Re-centre on ${p.id}`}
                >
                  <SensorChip sensor={p.sensor} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                    {p.satellite} · {p.acqDate} {p.acqTime}Z · {p.lat.toFixed(3)}, {p.lon.toFixed(3)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink/85">
                    {p.sensor === "modis"
                      ? p.confidencePct !== null
                        ? `${formatNum(p.confidencePct, 0)}%`
                        : p.confidence
                      : `${p.confidence} native`}
                  </span>
                  <span className="w-[74px] shrink-0 text-right font-mono text-[10.5px] text-ink">
                    {formatNum(p.frp, 1)} MW
                  </span>
                </button>
              );
            })}
          </div>
          <p className="border-t border-line/40 px-3.5 py-2 text-[10px] text-muted/80">
            A thermal anomaly is not a confirmed wildfire. Each row is one sensor retrieval
            ({data.observations.meta.returned} returned of{" "}
            {formatInt(data.summary?.totalDetections ?? 0)} in the AOI, ordered by FRP).
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------- day coverage */}
      {data.calendar ? (
        <section className="rounded-lg border border-line/70 bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3.5 py-2.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
              <CalendarDays size={11} /> Day-by-day coverage of this AOI
            </span>
            <span className="font-mono text-[9px] text-muted/70">{first} → {last}</span>
          </div>
          <div className="flex flex-wrap gap-1 p-3">
            {windowDays(data.calendar.days, first, last).map((d) => (
              <span
                key={d.date}
                title={`${d.date} · ${d.state} · MODIS ${d.modis} / VIIRS ${d.viirs}${
                  d.sensors?.modis?.evidence ? ` · ${d.sensors.modis.evidence}` : ""
                }${d.sensors?.viirs?.evidence ? ` · ${d.sensors.viirs.evidence}` : ""}`}
                className={cn(
                  "rounded border px-1.5 py-1 font-mono text-[9.5px]",
                  STATE_TONE[d.state] ?? STATE_TONE.unknown,
                )}
              >
                {d.date.slice(5)}
                <span className="ml-1 opacity-70">{STATE_SHORT[d.state] ?? d.state}</span>
                {d.total ? <span className="ml-1 text-ink/80">{d.total}</span> : null}
              </span>
            ))}
            {windowDays(data.calendar.days, first, last).length === 0 ? (
              <span className="px-1 py-1 text-[11px] text-muted">
                No stored day resolves inside this window for the AOI.
              </span>
            ) : null}
          </div>
          <div className="grid gap-2 border-t border-line/40 px-3.5 py-2.5 sm:grid-cols-2">
            <div>
              <p className="kicker">Missing dates in the window</p>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                {verdict.missingDates.length
                  ? verdict.missingDates.join(" · ")
                  : "none — every day in the window has delivery evidence"}
              </p>
            </div>
            <div>
              <p className="kicker">Days with a delivered product</p>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                {verdict.deliveredDates.length
                  ? `${verdict.deliveredDates.length} of ${likes.length} · ${verdict.deliveredDates[0]} → ${
                      verdict.deliveredDates[verdict.deliveredDates.length - 1]
                    }`
                  : "none"}
              </p>
            </div>
          </div>
          <p className="border-t border-line/40 px-3.5 py-2 text-[10px] leading-relaxed text-muted/80">
            {data.calendar.summary.unknownReason
              ? `Days outside this AOI's delivered window are UNKNOWN (${data.calendar.summary.unknownReason}), never zero. `
              : ""}
            {data.calendar.note ?? data.calendar.summary.note}
          </p>
        </section>
      ) : data.calendarError ? (
        <section className="rounded-lg border border-line/70 bg-panel px-3.5 py-2.5">
          <p className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
            <CalendarDays size={11} /> Day-by-day coverage of this AOI
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            The engine did not answer <span className="font-mono text-[10.5px]">/api/calendar</span> for
            this AOI ({data.calendarError}), so no day here can be called zero. The detection totals
            above are still the engine&apos;s answer for the bbox; only the day-level coverage claim is
            withheld, and the verdict is downgraded to COVERAGE UNKNOWN rather than assumed.
          </p>
          <button
            type="button"
            onClick={data.reload}
            className="mt-2 rounded border border-line bg-elevated/40 px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-cyan/40 hover:text-cyan"
          >
            Retry the chain
          </button>
        </section>
      ) : null}

      {/* --------------------------------------------- reference day (on demand) */}
      {last ? <ReferenceDay bbox={bboxStr} date={last} /> : null}

      {/* ------------------------------------------------------ ask the earth */}
      {data.ask || data.step === "grounded answer" ? (
        <AskBlock
          ask={data.ask}
          hours={data.hours}
          onHours={data.setHours}
          onReload={data.reload}
          onPick={onPick}
          pending={data.step === "grounded answer"}
        />
      ) : null}

      {/* ----------------------------------------------------------- deep links */}
      <DeepLinks lat={lat} lon={lon} radiusKm={radiusKm} bbox={bbox} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reference day — GET /api/day/{date}, only when asked for                   */
/* -------------------------------------------------------------------------- */

function ReferenceDay({ bbox, date }: { bbox: string; date: string }) {
  const [open, setOpen] = useState(false);
  const day = useApi<DayDetail>(`/api/day/${date}`, { bbox });
  return (
    <section className="rounded-lg border border-line/70 bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
          <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
          Reference day · {date} · per-sensor delivery evidence
        </span>
        <span className="font-mono text-[9px] text-muted/60">
          GET /api/day/{date}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line/50">
          {day.error ? (
            <p className="px-3.5 py-2 font-mono text-[10px] text-ember">{day.error}</p>
          ) : null}
          {!day.data && !day.error ? (
            <p className="inline-flex items-center gap-1.5 px-3.5 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
              <Loader2 size={9} className="animate-spin text-cyan" /> loading
            </p>
          ) : null}
          {day.data ? (
            <>
              <div className="flex items-center justify-between gap-2 px-3.5 py-2">
                <span className="kicker">Day state</span>
                <Badge
                  tone={
                    day.data.state === "observed"
                      ? "fire"
                      : day.data.state === "observed_zero"
                        ? "ok"
                        : "muted"
                  }
                >
                  {day.data.stateLabel}
                </Badge>
              </div>
              <div className="divide-y divide-line/40">
                {SENSORS.map((sensor) => {
                  const s = day.data?.sensors[sensor];
                  if (!s) return null;
                  return (
                    <div key={sensor} className="px-3.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <SensorChip sensor={sensor} count={s.count} />
                        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted/70">
                          {s.state}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[9.5px] leading-relaxed text-muted/90">
                        {s.evidence}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="border-t border-line/40 px-3.5 py-2 text-[10px] leading-relaxed text-muted/80">
                Delivery evidence is per sensor-day and global: it proves the product existed, not
                that this AOI was imaged cloud-free.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Ask the Earth — renders the grounded answer fetched by useAoiData          */
/* -------------------------------------------------------------------------- */

function AskBlock({
  ask, hours, onHours, onReload, onPick, pending,
}: {
  ask: import("@/lib/types").AskResponse | null;
  hours: number;
  onHours: (h: number) => void;
  onReload: () => void;
  onPick: (lat: number, lon: number) => void;
  pending: boolean;
}) {
  return (
    <section className="rounded-lg border border-line/70 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3.5 py-2.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-cyan/85">
          <Sparkles size={11} /> Ask the Earth · grounded answer
        </span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted/60">window</span>
          {[48, 96, 168, 240].map((h) => (
            <button
              key={h}
              onClick={() => onHours(h)}
              aria-pressed={hours === h}
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[9.5px] transition-colors",
                hours === h
                  ? "border-cyan/40 bg-cyan/10 text-cyan"
                  : "border-line bg-elevated/40 text-muted hover:text-ink",
              )}
            >
              {h} h
            </button>
          ))}
          <button
            onClick={onReload}
            className="grid h-6 w-6 place-items-center rounded border border-line bg-elevated/40 text-muted hover:text-ink"
            aria-label="Re-run the whole AOI query chain"
          >
            <RefreshCw size={10} className={pending ? "animate-spin" : undefined} />
          </button>
        </div>
      </div>

      {pending && !ask ? (
        <div className="flex items-center gap-2 px-3.5 py-4 text-[11.5px] text-muted">
          <Loader2 size={12} className="animate-spin text-cyan" /> Querying the engine for this point…
        </div>
      ) : null}

      {ask ? (
        <div className="space-y-3 p-3.5">
          <div>
            <h4 className="text-[12.5px] font-medium leading-snug text-ink">
              {ask.interpretation.headline}
            </h4>
            <p className="mt-1 font-mono text-[9.5px] text-muted/70">
              last {ask.selection.windowHours} h · radius {ask.selection.radiusKm} km ·{" "}
              {ask.selection.nearbySummary.count} in radius ·{" "}
              {ask.model.used
                ? `rephrased by ${displayModelName(ask.model.model) ?? "local model"}`
                : "deterministic engine"}
            </p>
          </div>

          {ask.interpretation.sections.map((s) => (
            <div key={s.title}>
              <h5 className="kicker">{s.title}</h5>
              <div className="mt-1 space-y-1">
                {s.body.map((p, i) => (
                  <p key={i} className="text-[11.5px] leading-relaxed text-muted">{p}</p>
                ))}
              </div>
            </div>
          ))}

          <div className="grid gap-1 rounded border border-line/50 bg-void/40 p-2 sm:grid-cols-2">
            {ask.interpretation.evidence.map((e) => (
              <div key={e.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] text-muted/80">{e.label}</span>
                <span className="truncate font-mono text-[10px] text-ink/90">{e.value}</span>
              </div>
            ))}
          </div>

          {ask.nearbyTop.length ? (
            <div>
              <h5 className="kicker">Nearest detections</h5>
              <div className="mt-1 divide-y divide-line/40 rounded border border-line/50">
                {ask.nearbyTop.slice(0, 4).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onPick(n.lat, n.lon)}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-elevated/40"
                  >
                    <SensorChip sensor={n.sensor} />
                    <span className="font-mono text-[9.5px] text-muted">{n.distanceKm.toFixed(1)} km</span>
                    <span className="font-mono text-[10px] text-ink/90">{formatNum(n.frp, 1)} MW</span>
                    <span className="font-mono text-[9px] text-muted/80">
                      {n.acqDate.slice(5)} {n.acqTime}Z
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-start gap-1.5 rounded border border-ember/20 bg-ember/[0.04] p-2">
            <AlertTriangle size={11} className="mt-0.5 shrink-0 text-ember/80" />
            <p className="text-[10px] leading-relaxed text-muted">
              {ask.interpretation.limitations[0] ?? "Absence of a detection is not evidence of absence."}{" "}
              Interpretation is computed from stored detections; it is not a forecast, a perimeter or
              an emergency statement.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line/50 pt-2">
            <BookOpen size={10} className="text-muted/70" />
            {ask.citations.slice(0, 3).map((c) => (
              <a
                key={c.id}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-muted transition-colors hover:text-cyan"
              >
                {c.title}
              </a>
            ))}
            <span className="ml-auto font-mono text-[9px] text-muted/60">
              {ask.model.available
                ? displayModelName(ask.model.model) ?? "local model"
                : "deterministic"} · {ask.generatedAt}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Deep links                                                                 */
/* -------------------------------------------------------------------------- */

function DeepLinks({
  lat, lon, radiusKm, bbox,
}: { lat: number; lon: number; radiusKm: number; bbox: [number, number, number, number] }) {
  const box = formatBbox(bbox);
  const point = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    bbox: box,
  }).toString();
  const question =
    `Compare MODIS and VIIRS detections within ${radiusKm} km of ${formatLatLon(lat, lon, 2)} ` +
    "over the stored window, and state what the coverage allows me to conclude.";

  const links = [
    { href: `/map?${point}`, label: "Fire map", hint: "bbox + marker" },
    { href: `/calendar?bbox=${box}`, label: "Calendar", hint: "AOI days" },
    { href: `/history?bbox=${box}`, label: "History", hint: "AOI trend" },
    {
      href: `/intelligence?q=${encodeURIComponent(question)}`,
      label: "Intelligence",
      hint: "evidence workspace",
    },
  ];

  return (
    <section className="rounded-lg border border-line/70 bg-panel px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.15em] text-muted">
          <MapPin size={11} /> Continue with this AOI
        </span>
        <span className="truncate font-mono text-[9px] text-muted/60">bbox {box}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group inline-flex items-center gap-1 rounded border border-line bg-elevated/40 px-2 py-1 text-[10.5px] text-muted transition-colors hover:border-cyan/40 hover:text-cyan"
          >
            {l.label}
            <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted/60 group-hover:text-cyan/70">
              {l.hint}
            </span>
            <ArrowUpRight size={9} />
          </Link>
        ))}
      </div>
      <p className="mt-2 text-[9.5px] leading-relaxed text-muted/60">
        Every link carries the same <span className="font-mono">bbox</span>, and each target applies it
        as the area of interest: the map fits it and marks the point, the calendar and history query
        the engine with it, and the workspace states it in the question.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-muted/60">{label}</dt>
      <dd className="mt-0.5 font-mono text-[10.5px] text-ink/90">{value}</dd>
    </div>
  );
}

function fmtMw(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${formatNum(v, 1)} MW`;
}

export function AoiLegend() {
  return (
    <p className="inline-flex items-center gap-1 text-[10px] text-muted/70">
      <Info size={10} /> unknown coverage ≠ zero detections
    </p>
  );
}

export const AOI_ICON = Target;
export { formatLat, formatLon };
