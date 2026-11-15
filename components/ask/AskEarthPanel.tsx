"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Cpu, HardDrive, Loader2, RefreshCw, Sparkles, Wrench, X,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

interface Obs {
  id?: string;
  lat?: number;
  lon?: number;
  acq_date?: string;
  acq_time?: string;
  confidence_class?: string;
  instrument?: string;
  satellite?: string;
  frp?: number | null;
  bright_ti4?: number | null;
  bright_ti5?: number | null;
}

interface AskResult {
  question: string;
  point: { lat: number; lon: number };
  evidence: { detection: Obs | null; summary: { total: number; meanFrp: number | null } };
  answer: { headline: string; body: string; confidence: string; limitations: string[]; evidence_used: string[]; phrasedBy?: string };
  model?: { mode?: string; available?: boolean; [k: string]: unknown };
}

interface Props {
  lat: number;
  lon: number;
  obsId?: string | null;
  onClose?: () => void;
}

const LOCAL_AI_BASE = "http://127.0.0.1:8020";

function formatNum(v: unknown, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

export function AskEarthPanel({ lat, lon, obsId = null, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [engineAi, setEngineAi] = useState<{ available?: boolean; mode?: string; detail?: string } | null>(null);
  const [localRuntime, setLocalRuntime] = useState<{ reachable: boolean; detail: string; model?: string } | null>(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const [showSetup, setShowSetup] = useState(true);

  const checkRuntime = useCallback(async () => {
    setCheckingRuntime(true);
    try {
      const [engine, local] = await Promise.all([
        apiGet<{ available?: boolean; mode?: string; detail?: string }>("/ai/status").catch(() => null),
        (() => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 1200); return fetch(`${LOCAL_AI_BASE}/api/status`, { cache: "no-store", signal: c.signal }).finally(() => clearTimeout(t)); })()
          .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .catch((e) => ({ __error: e instanceof Error ? e.message : "unreachable" })),
      ]);
      setEngineAi(engine);
      if (local && !(local as any).__error) {
        const lj: any = local;
        const ready = Boolean(lj?.runtime?.available ?? lj?.ready ?? lj?.ok ?? true);
        setLocalRuntime({
          reachable: true,
          detail: ready ? "Local runtime reachable on 127.0.0.1:8020." : "Local runtime reachable but model/runtime not fully ready.",
          model: lj?.model?.name || lj?.runtime?.model || lj?.model || undefined,
        });
      } else {
        setLocalRuntime({ reachable: false, detail: "No local runtime detected at 127.0.0.1:8020." });
      }
    } finally {
      setCheckingRuntime(false);
    }
  }, []);

  useEffect(() => { void checkRuntime(); }, [checkRuntime]);

  useEffect(() => {
    setResult(null);
    setError(null);
    setQuestion("");
  }, [lat, lon, obsId]);

  const ask = useCallback(async (q?: string) => {
    const text = (q ?? question).trim();
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost<AskResult>("/ask-the-earth", {
        lat,
        lon,
        radius_km: 50,
        question: text || null,
        obs_id: obsId,
      });
      setResult(res);
      if (!q) setQuestion(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to get an answer.");
    } finally {
      setLoading(false);
    }
  }, [lat, lon, obsId, question]);

  const obs = result?.evidence.detection ?? null;
  const runtimeMode = result?.model?.mode || (engineAi?.available ? "llm" : "deterministic");

  const runtimeBadge = useMemo(() => {
    if (localRuntime?.reachable) return { text: "Local runtime detected", cls: "border-ok/30 bg-ok/10 text-ok" };
    if (engineAi?.available) return { text: "Engine AI available", cls: "border-cyan/30 bg-cyan/10 text-cyan" };
    return { text: "Evidence-only mode", cls: "border-line/70 bg-void/30 text-muted" };
  }, [localRuntime, engineAi]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-cyan" />
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan">Ask the Earth</p>
            <p className="mt-0.5 font-mono text-[9.5px] text-muted">{lat.toFixed(4)}, {lon.toFixed(4)} · 50 km AOI</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.12em] ${runtimeBadge.cls}`}>
            {runtimeBadge.text}
          </span>
          {onClose ? (
            <button type="button" onClick={onClose} className="fw-btn fw-btn-secondary h-7 w-7 !p-0" aria-label="Close">
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div className="rounded-md border border-line/70 bg-raised/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">Selected evidence</p>
            <button type="button" onClick={() => void ask()} disabled={loading} className="fw-btn fw-btn-secondary h-7 px-2 text-[9px]">
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Analyze
            </button>
          </div>
          {obs ? (
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px]">
              <div><span className="text-muted">Sensor:</span> <span className="text-ink">{String(obs.instrument ?? "—")}</span></div>
              <div><span className="text-muted">Satellite:</span> <span className="text-ink">{String(obs.satellite ?? "—")}</span></div>
              <div><span className="text-muted">Acquired:</span> <span className="text-ink">{String(obs.acq_date ?? "—")} {String(obs.acq_time ?? "")}</span></div>
              <div><span className="text-muted">FRP:</span> <span className="text-ink">{formatNum(obs.frp, 1)} MW</span></div>
              <div><span className="text-muted">Confidence:</span> <span className="text-ink">{String(obs.confidence_class ?? "—")}</span></div>
              <div><span className="text-muted">Brightness:</span> <span className="text-ink">{formatNum(obs.bright_ti4, 1)} K</span></div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              No specific detection pinned. Ask for an area summary and the answer will use AOI evidence only.
            </p>
          )}
        </div>

        <div className="rounded-md border border-cyan/20 bg-cyan/[0.04] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu size={13} className="text-cyan" />
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-cyan">Local runtime setup</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowSetup((v) => !v)} className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted hover:text-ink">
                {showSetup ? "Hide" : "Show"}
              </button>
              <button type="button" onClick={() => void checkRuntime()} disabled={checkingRuntime} className="fw-btn fw-btn-secondary h-7 px-2 text-[9px]">
                {checkingRuntime ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check
              </button>
            </div>
          </div>
          {showSetup ? (
            <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-muted">
              <p>
                Ask the Earth works with engine evidence now. Optional local inference can phrase answers on-device when a local runtime is installed and running.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded border border-line/60 bg-void/30 p-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Status</p>
                  <p className="mt-1 text-[10.5px] text-ink">
                    {localRuntime?.reachable ? localRuntime.detail : (engineAi?.available ? "Engine AI phrasing available." : "No local runtime detected; deterministic evidence answers available.")}
                  </p>
                  {localRuntime?.model ? <p className="mt-1 font-mono text-[9px] text-muted">Model: {localRuntime.model}</p> : null}
                </div>
                <div className="rounded border border-line/60 bg-void/30 p-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Requirements</p>
                  <p className="mt-1 flex items-start gap-1.5"><HardDrive size={12} className="mt-0.5 shrink-0 text-cyan" />Disk/RAM depend on model choice; CPU baseline supported, GPU if runtime build supports it.</p>
                </div>
              </div>
              <div className="rounded border border-line/60 bg-void/30 p-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Setup (local package)</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4 text-[10.5px]">
                  <li>Install Python 3.11+ and project dependencies for <span className="font-mono text-ink/80">local_ai/</span>.</li>
                  <li>Start the local runtime server on loopback: <span className="font-mono text-ink/80">python -m firewatch_ai.server</span> (from <span className="font-mono text-ink/80">local_ai</span>).</li>
                  <li>Configure a supported local model/runtime as documented for your build, then click <span className="font-mono text-ink/80">Check</span>.</li>
                </ol>
                <p className="mt-2 flex items-start gap-1.5 text-[10px] text-muted">
                  <Wrench size={12} className="mt-0.5 shrink-0 text-ember" />
                  Install state is reported by live checks only. No simulated download or fake progress is shown.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void ask(); }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this area, sensor, FRP, trend, or confidence..."
            className="min-w-0 flex-1 rounded-md border border-line bg-void/50 px-3 py-2 text-[12px] text-ink placeholder:text-muted/50 outline-none focus:border-cyan/40"
          />
          <button type="submit" disabled={loading} className="fw-btn fw-btn-primary h-[38px] px-3">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Ask
          </button>
        </form>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-ember/30 bg-ember/10 p-3 text-[11px] text-ember">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {result ? (
          <div className="space-y-3 rounded-md border border-line/70 bg-raised/20 p-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">Answer</p>
              <p className="mt-1 font-display text-[15px] font-semibold text-ink">{result.answer.headline}</p>
              <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">{result.answer.body}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border border-line/60 bg-void/30 p-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Confidence</p>
                <p className="mt-1 text-[11px] text-ink">{result.answer.confidence || "—"}</p>
              </div>
              <div className="rounded border border-line/60 bg-void/30 p-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">Response mode</p>
                <p className="mt-1 text-[11px] text-ink">{String(result.answer.phrasedBy || runtimeMode || "deterministic")}</p>
              </div>
            </div>
            {result.answer.limitations?.length ? (
              <div className="rounded border border-ember/20 bg-ember/[0.04] p-2">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ember/80">Limitations</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-[10.5px] text-muted">
                  {result.answer.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            ) : null}
            {result.answer.evidence_used?.length ? (
              <p className="font-mono text-[9px] text-muted">Evidence used: {result.answer.evidence_used.join(", ")}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AskEarthTrigger() {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan">
      <Sparkles size={10} /> Ask the Earth
    </span>
  );
}
