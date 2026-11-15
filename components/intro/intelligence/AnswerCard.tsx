"use client";

/**
 * AnswerCard
 * ----------
 * Renders one engine answer. Every field comes from the response:
 *
 *   headline / sections  → engine prose (deterministic text, or model prose that
 *                          already passed the engine's number-grounding check)
 *   evidence[]           → the numbers the engine computed, as label/value pairs
 *   grounding            → how many numeric tokens were checked and whether any
 *                          were ungrounded (only meaningful for model prose)
 *   limitations          → engine-stated limits, always shown, never collapsed
 *   citations            → knowledge-base references
 *
 * There is no typewriter effect and no streamed "thinking" text: the streamed
 * path reveals sections as the engine emits them, which is real progress.
 */

import { useState } from "react";
import {
  ArrowUpRight, BookOpen, CheckCircle2, ChevronDown, Copy, Cpu, ShieldAlert, Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/format";
import { displayModelName } from "@/lib/model-label";
import { FadeIn } from "@/components/motion";
import type { AnswerMeta, AnswerView } from "./types";

const TRANSPORT_LABEL: Record<string, string> = {
  stream: "streamed",
  json: "single response",
  "json-direct": "direct engine connection",
};

const KIND_TONE: Record<string, string> = {
  measurement: "text-cyan/90",
  derived: "text-violet/90",
  time: "text-muted",
  geometry: "text-muted",
};

function groundingBadge(meta: AnswerMeta) {
  const status = meta.grounding.status;
  if (meta.mode === "deterministic" || status === "not_applicable") {
    return <Badge tone="muted">grounding n/a · computed</Badge>;
  }
  if (status === "passed") {
    return (
      <Badge tone="ok">
        <CheckCircle2 size={9} /> grounded · {meta.grounding.checked ?? 0} checks
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge tone="warn">
        <ShieldAlert size={9} /> model output rejected
      </Badge>
    );
  }
  return <Badge tone="muted">grounding {status}</Badge>;
}

export function AnswerCard({
  answer,
  meta,
  onFollowUp,
  streaming = false,
}: {
  answer: AnswerView;
  meta: AnswerMeta | Partial<AnswerMeta>;
  onFollowUp?: (q: string) => void;
  streaming?: boolean;
}) {
  const [openSources, setOpenSources] = useState(false);
  const [copied, setCopied] = useState(false);

  const fullMeta = meta as AnswerMeta;
  const mode = fullMeta.mode ?? "deterministic";

  const copy = async () => {
    const text = [
      answer.headline,
      ...answer.sections.flatMap((s) => [s.title, ...s.body]),
      "Evidence:",
      ...answer.evidence.map((e) => `${e.label}: ${e.value}`),
      "Limitations:",
      ...answer.limitations,
      ...answer.citations.map((c) => `${c.title} — ${c.url}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied: no fake success message */
    }
  };

  return (
    <FadeIn variant="rise-sm">
      <div className="rounded-xl border border-line/70 bg-elevated/20">
        <div className="flex items-start justify-between gap-3 border-b border-line/60 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-cyan/70">
              <Sparkles size={9} /> firewatch intelligence
              {streaming ? <span className="fw-dot ml-1 h-1 w-1 rounded-full bg-cyan" aria-hidden /> : null}
            </p>
            <h4 className="mt-1 text-[13.5px] font-medium leading-snug text-ink">
              {answer.headline || (streaming ? "Assembling evidence…" : "No headline returned")}
            </h4>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={mode === "llm" ? "cyan" : "muted"}>
              <Cpu size={9} />
              {mode === "llm" ? displayModelName(fullMeta.model?.model) ?? "local model" : "deterministic"}
            </Badge>
            <button
              onClick={copy}
              className="grid h-6 w-6 place-items-center rounded border border-line bg-elevated/50 text-muted transition-colors hover:text-ink"
              aria-label="Copy answer"
            >
              <Copy size={11} />
            </button>
          </div>
        </div>

        <div className="space-y-3 p-3.5">
          {answer.sections.map((s) => (
            <section key={s.title}>
              <h5 className="kicker mb-1">{s.title}</h5>
              <div className="space-y-1.5">
                {s.body.filter(Boolean).map((p, i) => (
                  <p key={i} className="text-[11.5px] leading-relaxed text-muted">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}

          {answer.evidence.length > 0 ? (
            <div>
              <h5 className="kicker mb-1.5">Numerical evidence</h5>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {answer.evidence.map((e) => (
                  <div key={`${e.label}-${e.value}`} className="rounded-md border border-line/60 bg-void/40 px-2 py-1.5">
                    <p className="break-words font-mono text-[8.5px] uppercase leading-snug tracking-[0.1em] text-muted/70">
                      {e.label}
                    </p>
                    <p
                      className={cn(
                        "mt-0.5 break-words font-mono text-[10.5px] leading-snug",
                        KIND_TONE[e.kind] ?? "text-ink/90",
                      )}
                      title={e.value}
                    >
                      {e.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {answer.limitations.length > 0 ? (
            <div className="rounded-md border border-line/50 bg-void/30 px-2.5 py-2">
              <p className="text-[10.5px] leading-relaxed text-muted/90">
                <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ember/80">Limits · </span>
                {answer.limitations.join(" ")}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/40 pt-2">
            {groundingBadge(fullMeta)}
            <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted/70">
              {fullMeta.modeLabel ?? "Deterministic evidence engine"}
              {typeof fullMeta.latencyMs === "number" ? ` · engine ${fullMeta.latencyMs} ms` : ""}
              {typeof fullMeta.wallMs === "number" &&
              typeof fullMeta.latencyMs === "number" &&
              fullMeta.wallMs > fullMeta.latencyMs * 1.5
                ? ` · round trip ${(fullMeta.wallMs / 1000).toFixed(1)} s`
                : ""}
              {fullMeta.transport ? ` · ${TRANSPORT_LABEL[fullMeta.transport] ?? fullMeta.transport}` : ""}
            </span>
            {fullMeta.mode === "llm" && answer.phrasedBy ? (
              <span className="font-mono text-[9px] text-cyan/70">
                phrased by {displayModelName(answer.phrasedBy)}
              </span>
            ) : null}
          </div>

          {fullMeta.grounding?.status === "rejected" && fullMeta.grounding.ungrounded?.length ? (
            <p className="rounded-md border border-ember/30 bg-ember/[0.06] px-2.5 py-2 font-mono text-[9.5px] leading-relaxed text-muted">
              The model wrote numbers that are not in the evidence payload ({fullMeta.grounding.ungrounded.join(", ")}
              ), so its wording was discarded and the deterministic answer is shown.
            </p>
          ) : null}

          {answer.citations.length > 0 ? (
            <div>
              <button
                onClick={() => setOpenSources((v) => !v)}
                className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted hover:text-cyan"
              >
                <ChevronDown size={10} className={cn("transition-transform", openSources && "rotate-180")} />
                {answer.citations.length} sources
              </button>
              {openSources ? (
                <div className="fw-stagger mt-1.5 space-y-1">
                  {answer.citations.map((c) => (
                    <a
                      key={c.id}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-start gap-1.5 text-[10.5px] leading-snug text-muted hover:text-cyan"
                    >
                      <BookOpen size={10} className="mt-0.5 shrink-0" />
                      <span>
                        {c.title}
                        <span className="block font-mono text-[9px] text-muted/60">{c.source}</span>
                      </span>
                      <ArrowUpRight size={9} className="mt-0.5 shrink-0 opacity-50" />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {copied ? <p className="font-mono text-[9.5px] text-ok">answer copied</p> : null}

          {onFollowUp && answer.followUps.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-t border-line/40 pt-2">
              {answer.followUps.slice(0, 3).map((q) => (
                <button
                  key={q}
                  onClick={() => onFollowUp(q)}
                  className="rounded-md border border-line bg-elevated/40 px-2 py-1 text-[10.5px] text-muted transition-colors hover:border-cyan/40 hover:text-cyan"
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </FadeIn>
  );
}
