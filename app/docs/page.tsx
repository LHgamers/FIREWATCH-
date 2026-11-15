"use client";

import Link from "next/link";
import { BookOpen, Database, Globe2, ShieldCheck, Terminal, Workflow } from "lucide-react";
import { Panel, PanelHeader, PanelBody, Metric } from "@/components/ui/Panel";
import { useApi, useMeta } from "@/lib/hooks";

type IntegrityResponse = {
  database?: { integrity?: string; badCoords?: number; missingTime?: number; badSensor?: number; missingSource?: number };
};

const SECTIONS = [
  {
    title: "Scientific scope",
    icon: ShieldCheck,
    body: "FIREWATCH AI visualizes NASA FIRMS thermal-anomaly detections from MODIS and VIIRS as an observation and decision-support layer. A hotspot is not automatically a confirmed wildfire or fire perimeter.",
  },
  {
    title: "Core workflows",
    icon: Workflow,
    body: "Use the Fire Map for spatial exploration, the monthly and daily calendars for temporal analysis, Intelligence for computed regional evidence, and FIREWATCH AI for evidence-grounded questions.",
  },
  {
    title: "Data & exports",
    icon: Database,
    body: "The application queries records stored by the FastAPI engine in SQLite. Historical archive backfill requires NASA FIRMS archive access; when it is unavailable, dates without stored evidence remain unknown rather than being represented as zero.",
  },
  {
    title: "API surface",
    icon: Terminal,
    body: "The Next.js app proxies /api/* to the FastAPI engine (ENGINE_URL). Analysis endpoints include /api/meta, /api/summary, /api/timeseries, /api/calendar, /api/calendar/history, /api/harmonization/v2, /api/intelligence, /api/integrity and /api/report.csv.",
  },
];

export default function DocsPage() {
  const meta = useMeta();
  const integrity = useApi<IntegrityResponse>("/api/integrity", {}, []);
  const coverage = meta.meta?.coverage;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line bg-surface/40 px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kicker">Documentation</p>
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Platform guide & scientific reference</h1>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
              How FIREWATCH AI works, what the data means, and how to interpret outputs responsibly. Values on this page come from the connected engine.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Metric label="Stored records" value={meta.meta?.engine.observations.toLocaleString() ?? "—"} />
            <Metric label="Coverage start" value={coverage?.first || "—"} />
            <Metric label="Coverage end" value={coverage?.last || "—"} />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <Panel key={s.title}>
                <PanelHeader title={s.title} icon={<Icon size={12} />} />
                <PanelBody>
                  <p className="text-[13px] leading-relaxed text-muted">{s.body}</p>
                </PanelBody>
              </Panel>
            );
          })}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel>
            <PanelHeader title="Interpretation notes" icon={<BookOpen size={12} />} />
            <PanelBody className="space-y-2 text-[12px] leading-relaxed text-muted">
              <p><span className="text-ink">Thermal anomaly</span>: satellite-detected heat signature consistent with active fire, volcanic activity, gas flares, or other hot sources depending on context.</p>
              <p><span className="text-ink">FRP</span>: fire radiative power is a proxy for radiant energy release, not a direct burned-area measurement.</p>
              <p><span className="text-ink">Confidence</span>: product-specific quality/assurance flags; compare within-sensor and with local conditions.</p>
              <p><span className="text-ink">Coverage zero</span>: product delivery is inferred globally by sensor and day; it does not prove that the selected AOI was imaged cloud-free.</p>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Transparency" icon={<Globe2 size={12} />} />
            <PanelBody className="space-y-2 text-[12px] leading-relaxed text-muted">
              <p>AI responses are grounded in the observations and summaries assembled by the engine. The UI distinguishes stored records, derived experimental indicators, and missing coverage.</p>
              <p className="text-[11px]">Database integrity: {integrity.loading ? "checking…" : integrity.error ? "unavailable" : integrity.data?.database?.integrity ?? "not reported"}.</p>
              <p className="text-[11px]">Archive access: {meta.meta?.archive.note ?? "status not reported"}.</p>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Quick links" icon={<Workflow size={12} />} />
            <PanelBody className="flex flex-col gap-2 text-[13px]">
              <Link className="text-cyan hover:underline" href="/map">Open Map</Link>
              <Link className="text-cyan hover:underline" href="/ask">Ask FIREWATCH AI</Link>
              <Link className="text-cyan hover:underline" href="/intelligence">Intelligence</Link>
              <Link className="text-cyan hover:underline" href="/calendar">Historical calendar</Link>
              <Link className="text-cyan hover:underline" href="/report">Research report</Link>
              <Link className="text-cyan hover:underline" href="/methodology">Methodology</Link>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
