"use client";

/**
 * ModelPanel
 * ----------
 * What the local-inference selector can and cannot do, stated in the UI.
 *
 * /api/ai/models returns the models Ollama actually has on disk, plus the one
 * the engine picked (`selected`). The engine reads `AI_MODEL` once at import
 * time, and `IntelligenceRequest` has no `model` field, so there is no
 * per-request override to bind a selector to. Rather than fake one, this panel:
 *
 *   • lists every installed model with its real size, parameter count and
 *     quantisation,
 *   • flags manifest-only stubs (a few kilobytes) as not runnable, because
 *     Ollama lists them but they cannot answer,
 *   • marks the model the engine will actually use,
 *   • lets you choose a preference and copies the exact environment line that
 *     would switch the engine to it (requires an engine restart).
 *
 * When nothing is reachable it says so and points at OLLAMA_SETUP.md. The
 * answers keep working either way, because the deterministic analyst is
 * computed in Python.
 */

import { useMemo, useState } from "react";
import { Check, Cpu, Copy, PlugZap, TriangleAlert } from "lucide-react";

import { Badge, DataNotice, SectionTitle } from "@/components/ui/primitives";
import { cn } from "@/lib/format";
import { displayModelName } from "@/lib/model-label";
import { LoadingIndicator } from "@/components/motion";
import type { AiModel, AiModelsResponse, AiStatus } from "@/lib/types";

/** Below this, an Ollama entry is a manifest stub and cannot run inference. */
const RUNNABLE_MIN_GB = 0.2;

function sizeLabel(m: AiModel): string {
  if (typeof m.sizeGb === "number" && m.sizeGb >= 1) return `${m.sizeGb.toFixed(1)} GB`;
  if (m.sizeBytes >= 1e9) return `${m.sizeGb?.toFixed(1) ?? "—"} GB`;
  if (m.sizeBytes >= 1e6) return `${Math.round(m.sizeBytes / 1e6)} MB`;
  if (m.sizeBytes > 0) return `${Math.round(m.sizeBytes / 1e3)} KB`;
  return "—";
}

export function ModelPanel({
  models,
  loading,
  error,
  status,
  selected,
  onSelect,
}: {
  models: AiModelsResponse | null;
  loading: boolean;
  error: string | null;
  status: AiStatus | null | undefined;
  /** Controlled selection: the page sends this model with every request. */
  selected?: string | null;
  onSelect?: (name: string) => void;
}) {
  const engineModel = models?.selected ?? status?.model ?? null;
  const [local, setLocal] = useState<string | null>(null);
  const preferred = selected ?? local;
  const setPreferred = (name: string) => {
    setLocal(name);
    onSelect?.(name);
  };
  const [copied, setCopied] = useState(false);

  const runnable = useMemo(
    () => (models?.models ?? []).filter((m) => (m.sizeGb ?? 0) >= RUNNABLE_MIN_GB),
    [models],
  );
  const stubs = useMemo(
    () => (models?.models ?? []).filter((m) => (m.sizeGb ?? 0) < RUNNABLE_MIN_GB),
    [models],
  );

  const chosen = preferred ?? engineModel ?? runnable[0]?.name ?? null;
  const envLine = chosen ? `AI_MODEL=${chosen}` : "AI_MODEL=";

  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(envLine);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied */
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Cpu size={12} className="text-muted" />
          <span className="text-[11.5px] text-muted">Local inference</span>
        </div>
        <Badge tone={models?.available ? "ok" : "muted"}>
          {models?.available ? <PlugZap size={9} /> : null}
          {models?.available ? "reachable" : "offline"}
        </Badge>
      </div>

      {loading && !models ? <LoadingIndicator size="sm" label="Reading /api/ai/models" /> : null}

      {error ? (
        <p className="rounded-md border border-ember/30 bg-ember/[0.06] px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-muted">
          /api/ai/models failed ({error}). The Intelligence page still answers: every number is computed by the
          engine, and the deterministic analyst needs no model.
        </p>
      ) : null}

      {!error && models && !models.available ? (
        <div className="rounded-md border border-line/70 bg-elevated/25 px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[11px] text-ink">
            <TriangleAlert size={11} className="text-ember" /> No local model is reachable
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted">
            {models.note ?? "Ollama is not answering on the configured base URL."} Answers fall back to the
            deterministic evidence engine, which is not a degraded mode: it renders the same computed payload.
            Installation steps are in <span className="font-mono text-ink/80">OLLAMA_SETUP.md</span>.
          </p>
        </div>
      ) : null}

      {runnable.length > 0 ? (
        <div>
          <SectionTitle right={<Badge tone="muted">{runnable.length} installed</Badge>}>Installed models</SectionTitle>
          <div className="space-y-1">
            {runnable.map((m) => {
              const inUse = m.name === engineModel;
              const picked = m.name === chosen;
              return (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => setPreferred(m.name)}
                  aria-pressed={picked}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                    picked ? "border-cyan/40 bg-cyan/[0.08]" : "border-line/70 bg-elevated/20 hover:border-line",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "grid h-3 w-3 shrink-0 place-items-center rounded-full border",
                        picked ? "border-cyan bg-cyan/20" : "border-line",
                      )}
                      aria-hidden
                    >
                      {picked ? <span className="h-1 w-1 rounded-full bg-cyan" /> : null}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-ink">
                      {displayModelName(m.name)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right font-mono text-[9px] text-muted">
                    {m.parameters || "—"} · {m.quantization || "—"} · {sizeLabel(m)}
                    {inUse ? <span className="ml-1 text-ok">in use</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {stubs.length > 0 ? (
        <div>
          <SectionTitle>Not runnable</SectionTitle>
          <div className="space-y-1">
            {stubs.map((m) => (
              <div
                key={m.name}
                className="flex items-center justify-between gap-2 rounded-md border border-line/50 bg-void/30 px-2 py-1.5"
                title="Ollama lists this entry but its weights are not present, so it cannot answer."
              >
                <span className="min-w-0 truncate font-mono text-[10px] text-muted/70">
                  {displayModelName(m.name)}
                </span>
                <span className="shrink-0 font-mono text-[9px] text-ember/80">manifest only · {sizeLabel(m)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-line/60 bg-void/30 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted/70">engine env</p>
          <button
            type="button"
            onClick={copyEnv}
            className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-cyan"
          >
            {copied ? <Check size={9} className="text-ok" /> : <Copy size={9} />}
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <p className="mt-1 break-all font-mono text-[10px] text-ink/85">
          {chosen ? "AI_MODEL=<selected model>" : "AI_MODEL="}
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
          The engine reads this line at startup as its default. Requests from this page also name the selected
          model explicitly, so switching the row above changes the next answer. A request that names a model
          which is not installed is rejected with HTTP 400 — it is never silently replaced by another model.
          Engine-default model:{" "}
          <span className="font-mono text-ink/80">{displayModelName(engineModel) ?? "none"}</span>.
        </p>
      </div>

      {models?.hardware ? (
        <p className="text-[10px] leading-relaxed text-muted/80">
          {models.hardware.gpu} · {models.hardware.vramGb} GB VRAM. {models.hardware.guidance}
        </p>
      ) : null}

      <DataNotice>
        A model only rephrases the engine&apos;s evidence. Every number it writes is checked against the evidence
        payload, and an answer with an ungrounded number is discarded in favour of the deterministic text.
      </DataNotice>
    </div>
  );
}
