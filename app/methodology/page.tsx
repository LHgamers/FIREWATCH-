"use client";

import { BookOpen, Database, Flame, Satellite, Scale, ShieldAlert, Sigma, CheckCircle2, AlertTriangle } from "lucide-react";
import { useMeta } from "@/lib/hooks";
import { formatInt } from "@/lib/format";

export default function MethodologyPage() {
  const { meta } = useMeta();
  const eng = meta?.engine;
  const coverage = meta?.coverage;

  return (
    <div className="min-h-full bg-bg">
      <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
        <header className="fw-panel p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan/80">Methods & transparency</p>
          <h1 className="mt-2 font-display text-[30px] font-semibold tracking-tight text-ink">Methodology</h1>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">
            How FIREWATCH AI ingests, normalizes, and presents satellite thermal anomaly detections for the selected area.
            This page documents the connected engine, current data sources, interpretation guidance, and limitations.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-line/60 bg-void/30 p-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Archive records</p>
              <p className="mt-1 font-mono text-[16px] font-semibold text-ink">{eng ? formatInt(eng.observations) : "—"}</p>
            </div>
            <div className="rounded-md border border-line/60 bg-void/30 p-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Coverage</p>
              <p className="mt-1 text-[12px] text-ink">{coverage?.first && coverage?.last ? `${coverage.first} → ${coverage.last}` : "No stored observation window"}</p>
            </div>
            <div className="rounded-md border border-line/60 bg-void/30 p-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Processing</p>
              <p className="mt-1 text-[12px] text-ink">FastAPI → SQLite</p>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="fw-panel p-5">
            <div className="mb-3 flex items-center gap-2 text-cyan"><Satellite size={14} /><h2 className="font-mono text-[10px] uppercase tracking-[0.16em]">Data sources</h2></div>
            <ul className="space-y-3 text-[13px] leading-relaxed text-muted">
              <li><span className="font-medium text-ink">NASA FIRMS:</span> MODIS C6.1 and VIIRS active-fire/thermal-anomaly records, including coordinates, acquisition time, source confidence, FRP (MW), platform, day/night, and other source fields where supplied.</li>
              <li><span className="font-medium text-ink">NASA EOSDIS GIBS:</span> optional satellite imagery for visual context. Imagery is not fused into a fire-perimeter or burned-area measurement.</li>
              <li><span className="font-medium text-ink">Historical archive:</span> the stored observation window is reported from the connected SQLite database. FIRMS archive access requires a configured key; without it, dates outside stored evidence remain unknown.</li>
            </ul>
          </article>

          <article className="fw-panel p-5">
            <div className="mb-3 flex items-center gap-2 text-cyan"><Database size={14} /><h2 className="font-mono text-[10px] uppercase tracking-[0.16em]">Processing pipeline</h2></div>
            <ol className="list-inside list-decimal space-y-2 text-[13px] leading-relaxed text-muted">
              <li><span className="font-medium text-ink">Ingest:</span> fetch available NASA FIRMS near-real-time feeds and, when authorized, historical archive windows into SQLite.</li>
              <li><span className="font-medium text-ink">Normalize:</span> map source fields to a common schema (time, coordinates, confidence, FRP, sensor/platform).</li>
              <li><span className="font-medium text-ink">Filter & aggregate:</span> apply spatial and temporal filters; exact polygon filtering is used where supported. Summaries, FRP statistics, coverage states, and calendar values are computed from stored rows.</li>
              <li><span className="font-medium text-ink">Serve:</span> expose deterministic JSON API responses consumed by the Next.js UI; optional LLM summarization only narrates provided evidence.</li>
            </ol>
          </article>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="fw-panel p-5">
            <div className="mb-3 flex items-center gap-2 text-cyan"><Flame size={14} /><h2 className="font-mono text-[10px] uppercase tracking-[0.16em]">Key metrics & interpretation</h2></div>
            <ul className="space-y-3 text-[13px] leading-relaxed text-muted">
              <li><span className="font-medium text-ink">Detection:</span> a satellite-observed thermal anomaly at overpass time; not a confirmed fire perimeter or incident report.</li>
              <li><span className="font-medium text-ink">FRP (Fire Radiative Power, MW):</span> estimate of radiative energy release at detection time; useful as an intensity proxy but not equivalent to burned area, duration, emissions, or impact.</li>
              <li><span className="font-medium text-ink">Confidence:</span> source-provided quality indicator; low confidence can still be informative in aggregate but should be treated cautiously.</li>
              <li><span className="font-medium text-ink">Clusters/hotspots:</span> spatial-temporal concentrations of detections that may indicate persistent activity; interpretation depends on context (land cover, weather, repeat overpasses).</li>
            </ul>
          </article>

          <article className="fw-panel p-5">
            <div className="mb-3 flex items-center gap-2 text-amber-300"><ShieldAlert size={14} /><h2 className="font-mono text-[10px] uppercase tracking-[0.16em]">Limitations & caveats</h2></div>
            <ul className="space-y-2 text-[13px] leading-relaxed text-muted">
              <li className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/80" /><span>Cloud cover, smoke, scan angle, and overpass timing can cause missed detections or duplicate observations.</span></li>
              <li className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/80" /><span>Detections are not validated burned area, suppression status, cause, or damage/loss.</span></li>
              <li className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/80" /><span>FRP comparability varies by sensor, conditions, and pixel characteristics; use trends and distributions with care.</span></li>
              <li className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/80" /><span>Archive completeness and regional coverage depend on actual ingested records, product delivery, and selected filters; absence of evidence is not evidence of absence.</span></li>
              <li className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/80" /><span>HFAI indicators remain experimental and are not calibrated to ground truth. The historical calendar may show a MODIS-reference occupied-cell-day index with a date-range-specific VIIRS factor only when later-year internal validation improves error; this is not independent validation or an FRP conversion.</span></li>
            </ul>
          </article>
        </section>

        <section className="fw-panel p-5">
          <div className="mb-3 flex items-center gap-2 text-cyan"><Scale size={14} /><h2 className="font-mono text-[10px] uppercase tracking-[0.16em]">Evidence, reproducibility, and independence</h2></div>
          <div className="grid gap-4 md:grid-cols-2 text-[13px] leading-relaxed text-muted">
            <div className="space-y-2">
              <p><span className="font-medium text-ink">Deterministic core:</span> statistics and map layers are computed from stored records by the engine. The same archive and filters yield consistent results.</p>
              <p><span className="font-medium text-ink">Provenance:</span> records preserve source metadata and API responses surface archive, coverage, and freshness context.</p>
            </div>
            <div className="space-y-2">
              <p><span className="font-medium text-ink">LLM role (if enabled):</span> natural-language explanations summarize engine-provided evidence only; they do not invent data or perform hidden measurements.</p>
              <p className="flex items-start gap-2 rounded-md border border-line/60 bg-void/30 p-3"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /><span><span className="font-medium text-ink">Independence statement:</span> FIREWATCH AI is an independent decision-support interface built for analysis of provided satellite detection data. It is not an official government emergency product and should be used alongside authoritative sources.</span></p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
