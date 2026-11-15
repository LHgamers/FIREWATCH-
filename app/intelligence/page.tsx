"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowUpRight, BookOpen, Cpu, Database, Layers, Plus, Send, Sparkles, Square, Trash2, User, X,
} from "lucide-react";

import { useApi, useMeta } from "@/lib/hooks";
import { useFilters } from "@/components/shell/FiltersProvider";
import { REGION_MAP } from "@/lib/regions";
import { Badge, DataNotice, KeyValue, Panel, PanelHead, Segmented } from "@/components/ui/primitives";
import { cn, formatInt } from "@/lib/format";
import { displayModelName } from "@/lib/model-label";
import { FadeIn, LoadingIndicator, RevealSection } from "@/components/motion";
import { AnswerCard } from "@/components/intro/intelligence/AnswerCard";
import { ModelPanel } from "@/components/intro/intelligence/ModelPanel";
import { useIntelligence } from "@/components/intro/intelligence/useIntelligence";
import type { AnswerMeta, AnswerView, IntelMode } from "@/components/intro/intelligence/types";
import type { AiModelsResponse, Summary } from "@/lib/types";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text?: string;
  answer?: AnswerView;
  meta?: AnswerMeta;
  error?: string;
  errorStatus?: number;
  at: number;
}

interface Session {
  id: string;
  title: string;
  at: number;
  turns: Turn[];
}

const SUGGESTIONS = [
  "How do MODIS and VIIRS differ in this region?",
  "Was the latest day unusual compared with the baseline?",
  "How reliable are these detections?",
  "What would archive access add to this analysis?",
  "When did the activity peak in the stored window?",
  "How many detections were recorded here?",
];

const STORAGE = "firewatch.sessions";

function loadSessions(): Session[] {
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Session[];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export default function IntelligencePage() {
  return (
    <Suspense fallback={<div className="p-6 text-[12px] text-muted">Loading the analyst…</div>}>
      <IntelligenceInner />
    </Suspense>
  );
}

function IntelligenceInner() {
  const params = useSearchParams();
  const { region } = useFilters();
  const { meta } = useMeta();
  const summary = useApi<Summary>("/api/summary", { region });
  const models = useApi<AiModelsResponse>("/api/ai/models", {});

  const { ask, cancel, busy, streaming, partial, partialMeta } = useIntelligence();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<IntelMode>("auto");
  const [railOpen, setRailOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const bootstrapped = useRef(false);

  const name = REGION_MAP[region]?.name ?? "Global";

  useEffect(() => {
    const stored = loadSessions();
    setSessions(stored);
    setSessionId(stored[0]?.id ?? crypto.randomUUID());
    setTurns(stored[0]?.turns ?? []);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const snapshot: Session = {
      id: sessionId,
      title: turns.find((t) => t.role === "user")?.text?.slice(0, 64) ?? "New analysis",
      at: Date.now(),
      turns,
    };
    setSessions((prev) => {
      const next = [snapshot, ...prev.filter((s) => s.id !== sessionId)].slice(0, 8);
      try {
        window.localStorage.setItem(STORAGE, JSON.stringify(next));
      } catch {
        /* quota */
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, sessionId]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text: q, at: Date.now() }]);
      setInput("");
      try {
        const result = await ask({
          question: q,
          region,
          start: summary.data?.start ?? null,
          end: summary.data?.end ?? null,
          mode,
          model: requestedModel ?? undefined,
        });
        setTurns((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", answer: result.answer, meta: result.meta, at: Date.now() },
        ]);
      } catch (e) {
        const err = e as Error & { status?: number };
        setTurns((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            error: err.message,
            errorStatus: typeof err.status === "number" ? err.status : undefined,
            at: Date.now(),
          },
        ]);
      }
    },
    [ask, busy, region, summary.data?.end, summary.data?.start, mode],
  );

  useEffect(() => {
    const q = params.get("q");
    if (q && !bootstrapped.current) {
      bootstrapped.current = true;
      void send(q);
    }
  }, [params, send]);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "end",
    });
  }, [turns, busy, partial]);

  const newAnalysis = () => {
    cancel();
    setSessionId(crypto.randomUUID());
    setTurns([]);
    setInput("");
  };

  const lastMeta = useMemo(() => [...turns].reverse().find((t) => t.meta)?.meta ?? null, [turns]);
  const engineModel = models.data?.selected ?? meta?.ai.model ?? null;
  // The selected model is sent with each request; the engine accepts only an
  // installed model and rejects anything else with 400.
  const [model, setModel] = useState<string | null>(null);
  const requestedModel = model ?? engineModel;

  return (
    <div className="grid gap-3 xl:grid-cols-[248px_minmax(0,1fr)_312px]">
      {/* ---------------------------------------------------------- sessions */}
      <div className="hidden space-y-3 xl:block">
        <Panel>
          <div className="p-3">
            <button className="btn btn-primary w-full justify-center" onClick={newAnalysis}>
              <Plus size={13} /> New analysis
            </button>
          </div>
          <PanelHead title="Sessions" hint="Stored locally in this browser" />
          <div className="max-h-[320px] overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="px-4 py-3 text-[11px] text-muted">No sessions yet.</p>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSessionId(s.id);
                    setTurns(s.turns);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 border-b border-line/40 px-3 py-2 text-left transition-colors hover:bg-elevated/40",
                    s.id === sessionId && "bg-cyan/5",
                  )}
                >
                  <Sparkles size={12} className={s.id === sessionId ? "text-cyan" : "text-muted/60"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-ink/90">{s.title || "New analysis"}</span>
                    <span className="font-mono text-[9px] text-muted/70">{s.turns.length} turns</span>
                  </span>
                </button>
              ))
            )}
          </div>
          {sessions.length ? (
            <div className="p-2">
              <button
                className="btn btn-ghost w-full justify-start text-[11px]"
                onClick={() => {
                  window.localStorage.removeItem(STORAGE);
                  setSessions([]);
                  newAnalysis();
                }}
              >
                <Trash2 size={12} /> Clear history
              </button>
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHead title="NASA documentation" hint="Retrieval sources" icon={<BookOpen size={13} />} />
          <div className="space-y-1 p-2">
            {[
              ["FIRMS product guides", "https://firms.modaps.eosdis.nasa.gov/content/descriptions/"],
              ["FIRMS data API", "https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html"],
              ["FIRMS FAQ", "https://firms.modaps.eosdis.nasa.gov/faq/"],
              ["GIBS / Worldview", "https://worldview.earthdata.nasa.gov/"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted transition-colors hover:bg-elevated/40 hover:text-ink"
              >
                <span className="truncate">{label}</span>
                <ArrowUpRight size={10} />
              </a>
            ))}
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------------- conversation */}
      <Panel className="flex min-h-[calc(100vh-150px)] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
          <div className="min-w-0">
            <p className="kicker">FIREWATCH Intelligence</p>
            <h2 className="mt-0.5 truncate text-[14px] font-medium text-ink">Evidence-grounded analysis</h2>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={lastMeta?.mode === "llm" ? "cyan" : "muted"}>
              <Cpu size={9} />
              {lastMeta
                ? lastMeta.mode === "llm"
                  ? `${displayModelName(lastMeta.model?.model) ?? "local model"} · phrased`
                  : "deterministic engine"
                : meta?.ai.available
                  ? "model available"
                  : "deterministic engine"}
            </Badge>
            <button
              onClick={() => setRailOpen((v) => !v)}
              className="hidden h-7 w-7 place-items-center rounded-md border border-line bg-elevated/50 text-muted hover:text-ink xl:grid"
              aria-label={railOpen ? "Hide context rail" : "Show context rail"}
            >
              <Layers size={13} />
            </button>
          </div>
        </div>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
          {turns.length === 0 && !busy ? (
            <div className="mx-auto max-w-2xl py-6 text-center">
              <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-cyan/25 bg-cyan/10">
                <Sparkles size={18} className="text-cyan" />
              </div>
              <h3 className="mt-3 text-[16px] font-medium text-ink">Ask about burned ground, not about a chatbot</h3>
              <p className="mx-auto mt-1.5 max-w-md text-[12px] leading-relaxed text-muted">
                Every answer is assembled from stored NASA detections for {name}. The engine computes the
                statistics; the assistant explains them and states the uncertainty.
              </p>
              <div className="mt-4 grid gap-2 text-left sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-lg border border-line/70 bg-elevated/25 px-3 py-2 text-left text-[11.5px] text-muted transition-colors hover:border-cyan/40 hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((t) =>
            t.role === "user" ? (
              <div key={t.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl border border-cyan/20 bg-cyan/[0.07] px-3.5 py-2.5">
                  <div className="mb-1 flex items-center justify-end gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-cyan/70">
                    <User size={9} /> you
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-ink">{t.text}</p>
                </div>
              </div>
            ) : t.answer && t.meta ? (
              <AnswerCard
                key={t.id}
                answer={t.answer}
                meta={t.meta}
                onFollowUp={(q) => void send(q)}
              />
            ) : (
              <FadeIn key={t.id} variant="rise-sm">
                <div className="rounded-xl border border-ember/25 bg-ember/[0.05] p-3.5">
                  <p className="text-[12px] text-ink">
                    {t.errorStatus === 503
                      ? "The local model is unavailable, so the request could not be completed."
                      : "The engine could not complete that request."}
                  </p>
                  <p className="mt-1 font-mono text-[10.5px] text-muted">{t.error}</p>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted/80">
                    Whole-planet statistics are the slowest query in the engine (they aggregate all stored
                    detections before the analyst can answer), so a timeout is the most likely cause. The
                    error above is the engine&apos;s own message, unedited.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      className="btn px-2 py-1 text-[11px]"
                      onClick={() => void send(turns.filter((x) => x.role === "user").slice(-1)[0]?.text ?? "")}
                    >
                      Retry
                    </button>
                    {mode !== "deterministic" ? (
                      <button
                        className="btn px-2 py-1 text-[11px]"
                        onClick={() => {
                          setMode("deterministic");
                          void send(
                            turns.filter((x) => x.role === "user").slice(-1)[0]?.text ?? "",
                          );
                        }}
                      >
                        Retry with the deterministic engine
                      </button>
                    ) : null}
                  </div>
                </div>
              </FadeIn>
            ),
          )}

          {busy && partial ? (
            <div className="opacity-95">
              <AnswerCard
                answer={partial}
                meta={partialMeta ?? { transport: "stream", mode: "deterministic" }}
                streaming
              />
            </div>
          ) : null}

          {busy && !partial ? (
            <div className="flex items-center gap-2">
              <LoadingIndicator
                label={mode === "llm" ? `Waiting for the local model over ${name}` : `Computing evidence for ${name}`}
                size="sm"
                variant="dots"
              />
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <form
          className="border-t border-line/70 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <div className="flex items-end gap-2 rounded-xl border border-line bg-void/50 p-2 focus-within:border-cyan/40">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder={`Ask about ${name}: sensor differences, anomalies, confidence, data limits…`}
              className="max-h-32 min-h-[34px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[12.5px] text-ink outline-none placeholder:text-muted/60"
            />
            {busy ? (
              <button
                type="button"
                onClick={cancel}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-ember/40 bg-ember/10 text-ember transition-colors hover:bg-ember/20"
                aria-label="Stop the request"
              >
                <Square size={11} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan/15 text-cyan transition-colors hover:bg-cyan/25 disabled:opacity-40"
                aria-label="Send question"
              >
                <Send size={14} />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1">
            <p className="font-mono text-[9.5px] text-muted/60">
              Numbers are computed by the engine · the assistant never estimates a measurement
              {streaming ? " · streaming deterministic sections" : ""}
            </p>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted/60">mode</span>
              <Segmented
                size="sm"
                value={mode}
                onChange={(v) => setMode(v)}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "deterministic", label: "Engine" },
                  { value: "llm", label: "Local model" },
                ]}
              />
            </div>
          </div>
          <p className="mt-1 px-1 font-mono text-[9px] leading-relaxed text-muted/45">
            Engine → streamed from /api/intelligence/stream and returns whole computed sections. Auto / Local
            model → one POST /api/intelligence response, because a rephrased answer has to be fully generated
            and grounding-checked before any of it is shown.
          </p>
        </form>
      </Panel>

      {/* ------------------------------------------------------- context rail */}
      {railOpen ? (
        <div className="space-y-3">
          <RevealSection>
            <Panel>
              <PanelHead title="Active context" hint="Sent with each question" icon={<Layers size={13} />} />
              <div className="space-y-1 p-3.5">
                <KeyValue label="Region" value={name} />
                <KeyValue
                  label="Bounding box"
                  value={(summary.data?.bbox ?? []).map((v) => v.toFixed(1)).join(", ") || "—"}
                />
                <KeyValue label="Coverage" value={`${meta?.coverage.first ?? "—"} → ${meta?.coverage.last ?? "—"}`} />
                <KeyValue label="Detections" value={formatInt(summary.data?.totalDetections)} />
                <KeyValue label="MODIS" value={formatInt(summary.data?.sensors.modis.detections)} />
                <KeyValue label="VIIRS" value={formatInt(summary.data?.sensors.viirs.detections)} />
                <KeyValue label="Data days" value={String(summary.data?.dataDays.length ?? "—")} />
                <KeyValue
                  label="Model in use"
                  value={displayModelName(engineModel) ?? "deterministic"}
                />
              </div>
            </Panel>
          </RevealSection>

          <RevealSection delay={60}>
            <Panel>
              <PanelHead title="Inference" hint="/api/ai/models" icon={<Cpu size={13} />} />
              <div className="p-3.5">
                <ModelPanel
                  models={models.data}
                  selected={requestedModel}
                  onSelect={(name) => setModel(name)}
                  loading={models.loading}
                  error={models.error}
                  status={meta?.ai}
                />
              </div>
            </Panel>
          </RevealSection>

          <RevealSection delay={120}>
            <Panel>
              <PanelHead title="Evidence policy" hint="How answers are built" icon={<Database size={13} />} />
              <div className="p-3.5">
                <DataNotice>
                  The engine selects observations, computes sensor statistics, the harmonized metric and the
                  baseline deviation. A local model may only rephrase that payload: every number it writes is
                  checked against the evidence, and a mismatch discards the paraphrase. With no model running the
                  deterministic analyst renders the same payload directly.
                </DataNotice>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href="/harmonization" className="link-quiet">
                    Method →
                  </Link>
                  <Link href="/report" className="link-quiet">
                    Export →
                  </Link>
                </div>
              </div>
            </Panel>
          </RevealSection>

          {lastMeta ? (
            <RevealSection delay={180}>
              <Panel>
                <PanelHead
                  title="Last answer"
                  hint="Transport and check status"
                  action={<X size={12} className="text-muted/40" />}
                />
                <div className="space-y-1 p-3.5">
                  <KeyValue label="Mode" value={lastMeta.mode} mono />
                  <KeyValue
                    label="Transport"
                    value={
                      lastMeta.transport === "stream"
                        ? "SSE stream (/api/intelligence/stream)"
                        : lastMeta.transport === "json-direct"
                          ? "direct engine POST (loopback)"
                          : "single POST (/api/intelligence)"
                    }
                  />
                  <KeyValue label="Engine latency" value={`${lastMeta.latencyMs} ms`} />
                  {typeof lastMeta.wallMs === "number" ? (
                    <KeyValue label="Round trip" value={`${(lastMeta.wallMs / 1000).toFixed(1)} s`} />
                  ) : null}
                  <KeyValue label="Grounding" value={lastMeta.grounding.status} />
                  <KeyValue label="Numbers checked" value={String(lastMeta.grounding.checked ?? 0)} />
                  {lastMeta.grounding.ungrounded.length ? (
                    <KeyValue label="Ungrounded" value={lastMeta.grounding.ungrounded.join(", ")} />
                  ) : null}
                </div>
              </Panel>
            </RevealSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
