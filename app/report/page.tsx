"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileText, Printer, ShieldCheck, AlertTriangle } from "lucide-react";

import { useFilters } from "@/components/shell/FiltersProvider";
import { Badge, ErrorState, Loading, Panel, PanelHead } from "@/components/ui/primitives";
import { buildUrl } from "@/lib/api";
import { formatDateTime, formatInt, formatNum } from "@/lib/format";
import { useApi, useMeta } from "@/lib/hooks";
import { bboxLabel, bboxParam, parseBbox } from "@/components/map/aoi";
import type { Summary } from "@/lib/types";

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ReportPage() {
  return (
    <Suspense fallback={<Loading label="Preparing the research report" />}>
      <ReportContent />
    </Suspense>
  );
}

function ReportContent() {
  const { region: selectedRegion } = useFilters();
  const searchParams = useSearchParams();
  const { meta } = useMeta();
  const rawBbox = searchParams.get("bbox");
  const polygon = searchParams.get("polygon");
  const bbox = rawBbox ? parseBbox(rawBbox) : null;
  const region = searchParams.get("region") ?? selectedRegion;
  const start = searchParams.get("start") ?? undefined;
  const end = searchParams.get("end") ?? undefined;
  const scope = polygon
    ? { polygon }
    : rawBbox ? { bbox: bbox ? bboxParam(bbox) : rawBbox } : { region };
  const query = { ...scope, start, end };
  const { data, error, loading, retry } = useApi<Summary>(
    "/api/summary",
    query,
    [JSON.stringify(query)],
    !rawBbox || bbox !== null,
  );
  const csvUrl = buildUrl("/api/report.csv", query).toString();
  const scopeName = polygon
    ? "Custom polygon"
    : bbox ? `Linked area ${bboxLabel(bbox)}` : data?.region ?? region;
  const generatedAt = new Date().toISOString();
  const report = {
    title: `FIREWATCH AI research report — ${scopeName}`,
    generatedAt,
    query: {
      area: data?.aoi ?? { kind: polygon ? "polygon" : bbox ? "bbox" : "region", region, bbox },
      start: start ?? null,
      end: end ?? null,
    },
    summary: data,
    coverage: data?.coverage ?? meta?.coverage ?? null,
    sources: meta?.attribution ?? [],
    interpretation: [
      "A satellite thermal anomaly is not automatically a confirmed wildfire or fire perimeter.",
      "FRP is reported in megawatts and is not burned area or fire duration.",
      "Unknown coverage is not zero activity; global product delivery does not prove cloud-free imaging of the selected AOI.",
    ],
  };

  if (rawBbox && !bbox) {
    return <ErrorState error={`The linked area "${rawBbox}" is not a valid W,S,E,N bounding box.`} />;
  }
  if (loading && !data) return <Loading label="Computing the selected-area report" />;
  if (error && !data) return <ErrorState error={error} onRetry={retry} />;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6 print:max-w-none print:p-0">
      <Panel className="overflow-hidden border-cyan/20">
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="kicker">Evidence-based export · {scopeName}</p>
              <h1 className="mt-2 font-display text-[28px] font-semibold leading-tight tracking-tight text-ink md:text-[36px]">
                Research report
              </h1>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">
                Computed from the selected area and date range. Raw MODIS and VIIRS detections are reported separately; experimental indicators are not presented as calibrated fire measurements.
              </p>
              {loading ? <p className="mt-2 font-mono text-[10px] text-muted">Refreshing the report…</p> : null}
              {error ? <p className="mt-2 font-mono text-[10px] text-ember">Refresh failed: {error}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2 print:hidden">
              <button type="button" onClick={() => window.print()} className="btn btn-ghost h-9 px-3 text-[11px]">
                <Printer size={14} /> Print / PDF
              </button>
              <a href={csvUrl} download className="btn btn-ghost h-9 px-3 text-[11px]">
                <Download size={14} /> CSV
              </a>
              <button
                type="button"
                onClick={() => downloadJson(`firewatch-report-${new Date().toISOString().slice(0, 10)}.json`, report)}
                className="btn btn-primary h-9 px-3 text-[11px]"
              >
                <Download size={14} /> JSON
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Detection records" value={formatInt(data.totalDetections)} />
            <Metric label="MODIS" value={formatInt(data.sensors.modis.detections)} detail={`${data.sensors.modis.days.length} detection days`} />
            <Metric label="VIIRS" value={formatInt(data.sensors.viirs.detections)} detail={`${data.sensors.viirs.days.length} detection days`} />
            <Metric label="AOI area" value={`${formatNum(data.areaKm2, 1)} km²`} />
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel>
          <PanelHead title="Computed findings" hint="Current query, not a hardcoded scenario" />
          <div className="space-y-3 p-4 text-[12px] leading-relaxed text-muted">
            <KeyValue label="Area" value={scopeName} />
            <KeyValue label="Bounding box" value={data.bbox.map((value) => formatNum(value, 3)).join(", ")} />
            <KeyValue label="Selected dates" value={`${data.start ?? start ?? "all stored dates"} → ${data.end ?? end ?? "latest stored date"}`} />
            <KeyValue label="Stored window" value={`${data.coverage?.first ?? meta?.coverage.first ?? "—"} → ${data.coverage?.last ?? meta?.coverage.last ?? "—"}`} />
            <KeyValue label="MODIS median FRP" value={`${formatNum(data.sensors.modis.frp.median)} MW`} />
            <KeyValue label="VIIRS median FRP" value={`${formatNum(data.sensors.viirs.frp.median)} MW`} />
            <KeyValue label="Generated (UTC)" value={formatDateTime(generatedAt)} />
            <p className="border-t border-line/50 pt-3">
              FRP summaries use source-reported fire radiative power. Detection records are observations, not unique incident counts.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Source and limitations" icon={<ShieldCheck size={13} />} />
          <div className="space-y-3 p-4 text-[12px] leading-relaxed text-muted">
            <p>Sources: NASA FIRMS MODIS C6.1 and VIIRS 375 m records in the connected engine.</p>
            <p>Historical archive: {meta?.archive.note ?? "archive access status not reported"}.</p>
            <div className="rounded-md border border-amber-300/25 bg-amber-300/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-300">
                <AlertTriangle size={12} /> Interpretation guardrail
              </div>
              <ul className="list-inside list-disc space-y-1">
                {report.interpretation.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Badge tone={meta?.archive.enabled ? "ok" : "warn"}>
                archive {meta?.archive.enabled ? "configured" : "not configured"}
              </Badge>
              <Badge tone="muted">generated from stored evidence</Badge>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-line/60 bg-void/30 p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-[17px] font-semibold text-ink">{value}</p>
      {detail ? <p className="mt-1 text-[10px] text-muted">{detail}</p> : null}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">{label}</span>
      <span className="max-w-[65%] break-words text-right font-mono text-[10px] tabular-nums text-ink">{value}</span>
    </div>
  );
}
