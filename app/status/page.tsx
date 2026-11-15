"use client";

import { Activity, AlertTriangle, Clock3, Database, Globe, Server, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";

import { Badge, ErrorState, Loading, PageHeader, Panel, PanelHead, RevealSection, StatCard } from "@/components/ui/primitives";
import { formatDateTime, formatInt, relativeAge } from "@/lib/format";
import { useApi, useMeta } from "@/lib/hooks";

type HealthResponse = {
  status: string;
  engine: string;
  uptimeSeconds: number;
  observations: number;
  ai?: { enabled?: boolean; status?: string };
};

type IntegrityResponse = {
  database: {
    integrity: string;
    badCoords: number;
    missingTime: number;
    badSensor: number;
    missingSource: number;
  };
  counts: { observations: number; modis: number; viirs: number };
};

type SourceStatusResponse = {
  generatedAt: string;
  sources: {
    id: string;
    label: string;
    sensor: string | null;
    status: string;
    note: string | null;
    lastRun: { status: string; finishedAt: number | null } | null;
    stored: { records: number; firstDate: string; lastDate: string; ingestedAt: number } | null;
    archiveReady: boolean | null;
  }[];
};

function tone(status: string): "ok" | "warn" | "muted" {
  if (["ok", "fresh", "running", "idle"].includes(status)) return "ok";
  if (["stale", "unknown", "empty"].includes(status)) return "warn";
  return "muted";
}

export default function StatusPage() {
  const health = useApi<HealthResponse>("/api/health", {}, []);
  const integrity = useApi<IntegrityResponse>("/api/integrity", {}, []);
  const sourceStatus = useApi<SourceStatusResponse>("/api/sources/status", {}, []);
  const { meta, error: metaError } = useMeta();

  const engineStatus = health.data?.status ?? "unavailable";
  const database = integrity.data?.database;
  const databaseStatus = database
    ? database.integrity === "ok" &&
      database.badCoords === 0 &&
      database.missingTime === 0 &&
      database.badSensor === 0 &&
      database.missingSource === 0
      ? "ok"
      : "warn"
    : "unavailable";
  const freshness = meta?.freshness;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform Status"
        subtitle="Health, data coverage, freshness, and source state reported by the running FIREWATCH AI engine."
        actions={<Badge tone={tone(engineStatus)}>{engineStatus}</Badge>}
      />

      <RevealSection>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Engine"
            value={health.loading ? "Checking" : engineStatus}
            hint={health.data?.engine ?? "FastAPI"}
            tone={engineStatus === "ok" ? "ok" : "ember"}
          />
          <StatCard
            label="Stored records"
            value={formatInt(meta?.engine.observations)}
            hint={`MODIS ${formatInt(meta?.engine.modis)} · VIIRS ${formatInt(meta?.engine.viirs)}`}
            tone="cyan"
          />
          <StatCard
            label="Database integrity"
            value={integrity.loading ? "Checking" : databaseStatus}
            hint={database ? `${database.badCoords + database.missingTime + database.badSensor + database.missingSource} flagged rows` : "SQLite integrity probe"}
            tone={databaseStatus === "ok" ? "ok" : "amber"}
          />
          <StatCard
            label="Latest stored observation"
            value={meta?.coverage.last ?? "—"}
            hint={freshness?.lastSuccessAt ? `checked ${relativeAge(freshness.lastSuccessAt)}` : "not yet checked"}
            tone="amber"
          />
        </div>
      </RevealSection>

      {health.error ? <ErrorState error={`Engine health request failed: ${health.error}`} onRetry={health.retry} /> : null}
      {integrity.error ? <ErrorState error={`Database integrity request failed: ${integrity.error}`} onRetry={integrity.retry} /> : null}
      {metaError ? <ErrorState error={`Engine metadata request failed: ${metaError}`} /> : null}

      <RevealSection delay={40}>
        <div className="grid gap-3 xl:grid-cols-12">
          <Panel className="xl:col-span-6">
            <PanelHead title="Coverage and freshness" hint="Stored evidence, not assumed observation opportunity" />
            <div className="space-y-3 p-4">
              <StatusRow
                icon={Globe}
                label="Stored observation window"
                value={`${meta?.coverage.first ?? "—"} → ${meta?.coverage.last ?? "—"}`}
                detail={`${formatInt(meta?.coverage.days.length)} dates with delivery evidence`}
                status={meta?.coverage.first ? "ok" : "unknown"}
              />
              <StatusRow
                icon={Clock3}
                label="Last successful update"
                value={freshness?.lastSuccessAt ? formatDateTime(freshness.lastSuccessAt) : "Not reported"}
                detail={freshness?.scheduler.note ?? "Update schedule not reported"}
                status={freshness?.state ?? "unknown"}
              />
              <StatusRow
                icon={Activity}
                label="Next scheduled check"
                value={freshness?.nextCheckAt ? formatDateTime(freshness.nextCheckAt) : "Not scheduled"}
                detail={freshness?.scheduler.enabled ? `${freshness.scheduler.intervalSeconds}s interval` : "Scheduler disabled"}
                status={freshness?.scheduler.enabled ? "ok" : "unknown"}
              />
              <StatusRow
                icon={Database}
                label="Historical archive"
                value={meta?.archive.enabled ? "Configured" : "Not configured"}
                detail={meta?.archive.note ?? "Archive status not reported"}
                status={meta?.archive.enabled ? "ok" : "unknown"}
              />
              {freshness?.lastError ? (
                <p className="rounded-md border border-ember/30 bg-ember/5 p-3 text-[11px] leading-relaxed text-muted">
                  Latest ingest issue: {freshness.lastError}
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel className="xl:col-span-6">
            <PanelHead title="NASA source status" hint="Per-source state returned by /api/sources/status" />
            <div className="space-y-2 p-4">
              {sourceStatus.loading && !sourceStatus.data ? <Loading label="Checking source status" /> : null}
              {sourceStatus.error ? (
                <ErrorState error={sourceStatus.error} onRetry={sourceStatus.retry} />
              ) : null}
              {(sourceStatus.data?.sources ?? []).map((source) => (
                <div key={source.id} className="rounded-md border border-line/70 bg-void/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12px] font-medium text-ink">{source.label}</p>
                    <Badge tone={tone(source.status)}>{source.status}</Badge>
                  </div>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-muted">
                    {source.note || (source.stored
                      ? `${formatInt(source.stored.records)} stored (${source.stored.firstDate}–${source.stored.lastDate})`
                      : "No source-specific note is available.")}
                    {source.note && source.stored
                      ? ` · ${formatInt(source.stored.records)} stored (${source.stored.firstDate}–${source.stored.lastDate})`
                      : null}
                  </p>
                </div>
              ))}
              {!sourceStatus.loading && !sourceStatus.error && !sourceStatus.data?.sources.length ? (
                <p className="text-[11px] text-muted">The engine returned no source records.</p>
              ) : null}
            </div>
          </Panel>
        </div>
      </RevealSection>

      <RevealSection delay={80}>
        <Panel>
          <PanelHead title="Interpretation and known limits" icon={<ShieldCheck size={13} />} />
          <div className="grid gap-3 p-4 text-[12px] leading-relaxed text-muted md:grid-cols-2">
            <p><AlertTriangle size={13} className="mr-1 inline text-amber-300" />NASA FIRMS observations have publication latency; the latest stored date is not necessarily today.</p>
            <p><AlertTriangle size={13} className="mr-1 inline text-amber-300" />A delivered product does not prove that the selected AOI was imaged cloud-free. Unknown and unavailable coverage are not zero activity.</p>
            <p>MODIS and VIIRS have different spatial footprints, platforms, algorithms, and observation opportunities; their raw detections are shown separately.</p>
            <p>HFAI values remain experimental and are not calibrated to ground truth. The historical calendar’s separate occupied-cell-day index may use a region- and date-range-specific VIIRS factor after later-year internal validation; this is not external validation or an FRP conversion.</p>
            <p className="md:col-span-2">
              Read the <Link href="/methodology" className="text-cyan underline decoration-cyan/30">methodology</Link> and inspect the <Link href="/calendar" className="text-cyan underline decoration-cyan/30">historical calendar</Link> before interpreting trends.
            </p>
          </div>
        </Panel>
      </RevealSection>
    </div>
  );
}

function StatusRow({
  icon: Icon, label, value, detail, status,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  status: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line/70 bg-void/20 p-3">
      <Icon size={14} className="mt-0.5 shrink-0 text-cyan/80" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted">{label}</p>
          <Badge tone={tone(status)}>{status}</Badge>
        </div>
        <p className="mt-1 font-mono text-[11px] text-ink">{value}</p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{detail}</p>
      </div>
    </div>
  );
}
