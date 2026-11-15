"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Check, Cpu, Database, ExternalLink, Film, PlayCircle, Server, ShieldCheck, Volume2, VolumeX,
} from "lucide-react";
import { useApi, useMeta } from "@/lib/hooks";
import { useTheme } from "@/components/shell/ThemeProvider";
import type { AiModelsResponse } from "@/lib/types";
import { useFilters } from "@/components/shell/FiltersProvider";
import { REGIONS } from "@/lib/regions";
import {
  Badge, DataNotice, KeyValue, Loading, Panel, PanelHead, SectionTitle, Segmented,
} from "@/components/ui/primitives";
import { formatDateTime, relativeAge } from "@/lib/format";
import { displayModelName } from "@/lib/model-label";
import { getIntroMuted, setIntroMuted } from "@/lib/intro-prefs";
import {
  readMotionPref, useMotionEnabled, usePrefersReducedMotion, writeMotionPref,
  type MotionPref,
} from "@/lib/motion";

/**
 * A model is only usable if its weights are actually on disk. `/api/ai/models`
 * reports Ollama's registry entries verbatim, and a registry entry can be a
 * manifest with no layers (measured: `treyleo16/claude-opus-5-5:latest`,
 * 27,816 bytes). Anything under this threshold cannot generate a token.
 */
const RUNNABLE_MIN_BYTES = 200 * 1024 * 1024;

function isRunnable(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes >= RUNNABLE_MIN_BYTES;
}

function formatSize(sizeBytes: number | null | undefined): string {
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) return "unknown size";
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function SettingsPage() {
  const { meta } = useMeta();
  const { region } = useFilters();
  const { theme, resolved, setTheme } = useTheme();
  const { data: aiModels } = useApi<AiModelsResponse>("/api/ai/models", {});
  const [muted, setMuted] = useState(getIntroMuted);

  const [motionPref, setMotionPref] = useState<MotionPref>("system");
  const motionOn = useMotionEnabled();
  const osReduces = usePrefersReducedMotion();
  useEffect(() => setMotionPref(readMotionPref()), []);

  const changeMotion = (next: MotionPref) => {
    setMotionPref(next);
    writeMotionPref(next);
  };

  const runnable = (aiModels?.models ?? []).filter((m) => isRunnable(m.sizeBytes));
  const stubs = (aiModels?.models ?? []).filter((m) => !isRunnable(m.sizeBytes));

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setIntroMuted(next);
  };

  const replay = () => {
    window.location.href = "/?intro=1";
  };

  return (
    <div className="fw-stagger space-y-4">
      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel>
          <PanelHead title="Data access" hint="NASA FIRMS" icon={<Database size={14} />} />
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted">Multi-year archive</span>
              <Badge tone={meta?.archive.enabled ? "ok" : "warn"}>
                {meta?.archive.enabled ? "enabled" : "not configured"}
              </Badge>
            </div>
            <p className="text-[11.5px] leading-relaxed text-muted">{meta?.archive.note}</p>
            <div className="rounded-md border border-line/70 bg-void/50 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
              <p className="text-ink/70"># .env</p>
              <p>FIRMS_MAP_KEY=your_key</p>
              <p className="mt-1 text-muted/70">restart engine/run.py</p>
            </div>
            <p className="text-[10.5px] leading-relaxed text-muted/70">
              A free key is issued by NASA FIRMS after registration. The key lives only in the engine process
              and is never sent to the browser.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Local inference" hint="Hardware-aware, optional" icon={<Cpu size={14} />} />
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted">Model status</span>
              <Badge tone={meta?.ai.available ? "ok" : "muted"}>
                {meta?.ai.available ? "connected" : "offline"}
              </Badge>
            </div>
            <p className="text-[11.5px] leading-relaxed text-muted">{meta?.ai.note}</p>
            <div className="space-y-1">
              <KeyValue label="Provider" value={meta?.ai.provider ?? "none"} />
              <KeyValue label="Model" value={displayModelName(meta?.ai.model) ?? "—"} />
              <KeyValue label="Mode" value={meta?.ai.mode === "llm" ? "rephrasing evidence" : "deterministic"} />
              <KeyValue label="Installed" value={String(runnable.length)} />
            </div>
            {runnable.length ? (
              <div className="space-y-1.5">
                <SectionTitle>Runnable models</SectionTitle>
                {runnable.map((m) => (
                  <div key={m.name} className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-elevated/20 px-2 py-1.5">
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-ink">
                      {displayModelName(m.name)}
                    </span>
                    <span className="shrink-0 font-mono text-[9.5px] text-muted">
                      {m.parameters || "—"} · {m.quantization || "—"} · {formatSize(m.sizeBytes)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {stubs.length ? (
              <div className="space-y-1.5">
                <SectionTitle>Registry entries without weights</SectionTitle>
                {stubs.map((m) => (
                  <div key={m.name} className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-void/40 px-2 py-1.5">
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted/80">
                      {displayModelName(m.name)}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted/70">
                      manifest only · {formatSize(m.sizeBytes)} · not runnable
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {aiModels?.hardware ? (
              <p className="text-[10.5px] leading-relaxed text-muted">
                {aiModels.hardware.gpu} · {aiModels.hardware.vramGb} GB VRAM. {aiModels.hardware.guidance}
              </p>
            ) : null}
            <DataNotice>
              Answers are computed by the scientific engine either way. A local model only rephrases the
              evidence; every number it writes is checked against the evidence payload and the answer is
              rejected if a number cannot be grounded.
            </DataNotice>
            <p className="rounded-lg border border-line/60 bg-void/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted">
              A model answer takes about 40 s on this machine, and the dev server&apos;s
              <span className="font-mono text-ink"> /api </span>
              proxy drops responses slower than ~32 s (measured). FIREWATCH Intelligence therefore retries the
              same request against the engine on loopback and labels that answer &ldquo;direct engine
              connection&rdquo;; if that is unavailable it streams the deterministic answer instead. Raising
              <span className="font-mono text-ink"> proxyTimeout </span>
              in <span className="font-mono text-ink">next.config.mjs</span> would remove the detour.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Appearance" hint="Applies immediately" icon={<Check size={14} />} />
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] text-ink">Colour theme</p>
                <p className="mt-0.5 text-[10.5px] text-muted">
                  Currently {resolved}. System follows your operating system.
                </p>
              </div>
              <Segmented
                size="sm"
                value={theme}
                onChange={(v) => setTheme(v)}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            </div>
            <p className="text-[10.5px] leading-relaxed text-muted">
              The preference is stored in this browser only. Charts and the map re-read the palette when the
              theme changes.
            </p>
            <div className="border-t border-line/50 pt-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[12px] text-ink">Motion</p>
                  <p className="mt-0.5 text-[10.5px] text-muted">
                    {motionOn
                      ? "Animations run. New content fades in; numbers count up to the value the engine returned."
                      : "Animations are off. Every value is drawn in its final state."}
                    {motionPref === "system" && osReduces
                      ? " Your operating system asks for reduced motion, so Match OS means off."
                      : ""}
                  </p>
                </div>
                <Segmented
                  size="sm"
                  value={motionPref}
                  onChange={(v) => changeMotion(v as MotionPref)}
                  options={[
                    { value: "system", label: "Match OS" },
                    { value: "full", label: "On" },
                    { value: "reduced", label: "Off" },
                  ]}
                />
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-muted/80">
                System follows <span className="font-mono text-ink">prefers-reduced-motion</span>. Forcing
                motion on never changes a value — only how quickly it is drawn.
              </p>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Cinematic intro" hint="Replay and preferences" icon={<Film size={14} />} />
          <div className="space-y-3 p-4">
            <button className="btn w-full justify-start" onClick={replay}>
              <PlayCircle size={14} /> Replay introduction
            </button>
            <button className="btn w-full justify-start" onClick={toggleMute}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              Sound {muted ? "muted" : "enabled"}
            </button>
            <p className="rounded-lg border border-line/60 bg-elevated/30 px-3 py-2 text-[10.5px] leading-relaxed text-muted">
              The sequence now plays on <span className="text-ink">every page load</span>. Skip it at any time;
              <span className="font-mono text-ink"> ?intro=0 </span>
              loads the app without it. Reduced-motion preferences are respected.
            </p>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHead title="Data sources" hint="Every feed the platform can read" icon={<Server size={14} />} />
        {!meta ? (
          <Loading label="Reading source registry" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-line/70 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
                  <th className="px-4 py-2.5 font-normal">Dataset</th>
                  <th className="px-4 py-2.5 font-normal">Provider</th>
                  <th className="px-4 py-2.5 font-normal">Resolution</th>
                  <th className="px-4 py-2.5 font-normal">Coverage</th>
                  <th className="px-4 py-2.5 font-normal">Access</th>
                  <th className="px-4 py-2.5 font-normal">Docs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {meta.sources.map((src) => (
                  <tr key={src.id} className="hover:bg-elevated/25">
                    <td className="px-4 py-2.5 text-ink/90">{src.label}</td>
                    <td className="px-4 py-2.5 text-muted">{src.provider}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-muted">{src.resolution}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-muted">{src.coverage}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={src.access === "open" ? "ok" : "warn"}>{src.access}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <a href={src.url} target="_blank" rel="noreferrer" className="link-quiet inline-flex items-center gap-1">
                        NASA <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHead title="Coverage & ingestion" hint="What is actually stored" />
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-line/60 bg-elevated/25 px-3 py-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">Stored detections</p>
                <p className="value mt-1 text-[16px]">{meta ? meta.engine.observations.toLocaleString("en-US") : "—"}</p>
              </div>
              <div className="rounded-md border border-line/60 bg-elevated/25 px-3 py-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">Data days</p>
                <p className="value mt-1 text-[16px]">{meta?.coverage.days.length ?? "—"}</p>
              </div>
            </div>
            <div className="space-y-1">
              <SectionTitle>Recent runs</SectionTitle>
              {(meta?.runs ?? []).map((run) => (
                <div key={run.id} className="flex items-center justify-between gap-2 border-b border-line/40 py-1.5 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[10.5px] text-ink/90">{run.source}</p>
                    <p className="font-mono text-[9.5px] text-muted">
                      {run.records.toLocaleString("en-US")} records · {relativeAge(new Date(run.started_at).toISOString())}
                    </p>
                  </div>
                  <Badge tone={run.status === "ok" ? "ok" : "warn"}>{run.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="Methodology & limits" hint="The short version" icon={<ShieldCheck size={14} />} />
          <div className="space-y-3 p-4 text-[11.5px] leading-relaxed text-muted">
            <p>
              MODIS (1 km) and VIIRS (375 m) are reduced to cell-days at 0.1°, 0.25° or 0.5°. Repeated
              overpasses are collapsed with a per-cell maximum. HFAI-v1 is FRP per km² of active burning area
              per day; HFAI-v2 restricts the comparison to cell-days both sensors reported. Both are
              experimental, region-specific, and reported with a bootstrap interval. Density changes with grid
              size, so the grid is always shown with the number.
            </p>
            <p>
              Anomalies use a robust z-score against the stored baseline — (x − median) / (1.4826 × MAD) — and
              report the baseline size. With fewer than seven observed baseline days no deviation is claimed.
            </p>
            <p>
              Every day carries one of three states: observed, verified zero (product delivered, no detection
              here) or unknown (no delivery evidence). Unknown is never plotted as zero. Confidence fields are
              shown in their native form, with an explicitly labelled low/nominal/high view.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link href="/harmonization" className="btn">Harmonization lab</Link>
              <Link href="/report" className="btn">Evidence pack</Link>
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[13px] font-medium text-ink">FIREWATCH AI · LH Studios</p>
            <p className="mt-1 text-[11.5px] text-muted">
              “See the patterns. Understand the fires. Protect the future.”
            </p>
            <p className="mt-2 font-mono text-[10px] text-muted/70">
              NASA Space Apps Challenge 2026 · Harmonization of MODIS and VIIRS Hot Spots
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="cyan">{REGIONS.find((r) => r.id === region)?.name ?? "Global"}</Badge>
            <Badge tone="muted">engine v{meta?.engine.version ?? "1.0.0"}</Badge>
            <Badge tone={meta?.ai.available ? "ok" : "muted"}>{meta?.ai.available ? "local model" : "deterministic"}</Badge>
          </div>
        </div>
      </Panel>
    </div>
  );
}
