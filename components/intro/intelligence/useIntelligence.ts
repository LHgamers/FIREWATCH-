"use client";

/**
 * useIntelligence — the only place this page talks to the analyst.
 *
 * Contract (read from engine/app/analyst.py + engine/app/main.py and verified
 * against the running engine):
 *
 *   POST /api/intelligence
 *     body  { question, region? | bbox?, start?, end?, mode: "auto"|"deterministic"|"llm" }
 *     200   { answer{headline,sections,evidence,limitations,citations,followUps,data},
 *             model, mode, modeLabel, grounding{status,checked,ungrounded},
 *             region, bbox, window, deterministic, latencyMs }
 *
 *   POST /api/intelligence/stream
 *     body  same
 *     200   text/event-stream: meta → headline → section* → evidence →
 *           limitations → citations → done
 *
 * Three facts drive the transport choice:
 *
 *  1. The engine's stream handler calls the analyst with mode="deterministic"
 *     unconditionally, so a streamed answer is always the deterministic one.
 *     The page therefore streams when the user asked for the deterministic
 *     engine and uses the JSON endpoint when a local model may rephrase.
 *  2. A model outage is not an answer failure. HTTP 503 falls back to the
 *     deterministic analyst, and the answer says so.
 *  3. The buffered JSON response for a whole-planet request does not survive
 *     the dev proxy (measured: engine 12–15 s, proxy 500 at ~31.6 s), while the
 *     streamed transport does. A 5xx on the JSON path therefore falls back to
 *     the stream once, and the answer is labelled as a fallback.
 */

import { useCallback, useRef, useState } from "react";
import type { IntelligenceResponse } from "@/lib/types";
import type {
  AnswerMeta,
  AnswerView,
  IntelMode,
  IntelligenceTurnResult,
  StreamEvent,
} from "./types";
import { IntelligenceError } from "./types";

/**
 * Dev-only escape hatch.
 *
 * The same-origin `/api/*` rewrite in next.config.mjs drops any response that
 * takes longer than ~32 s, and a local-model answer takes ~40 s in the engine.
 * When the page is served from this machine we may therefore talk to the engine
 * directly (CORS is open in this build: `access-control-allow-origin: *`).
 *
 * This is used only as a fallback after the proxy has already failed, only for
 * a model-phrased request, and only on a loopback host. The answer records
 * `transport: "json-direct"` so the UI can say so.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function directEngineBase(): string | null {
  if (typeof window === "undefined") return null;
  const configured = process.env.NEXT_PUBLIC_ENGINE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (!LOOPBACK_HOSTS.has(window.location.hostname)) return null;
  return "http://127.0.0.1:8010";
}

interface RequestOptions {
  question: string;
  region: string;
  start?: string | null;
  end?: string | null;
  mode: IntelMode;
  /** Installed model to use for a rephrased answer; the engine rejects others. */
  model?: string | null;
  /** Called with each partial answer while a stream is arriving. */
  onPartial?: (partial: AnswerView, meta: Partial<AnswerMeta>) => void;
}

const EMPTY_ANSWER: AnswerView = {
  headline: "",
  sections: [],
  evidence: [],
  limitations: [],
  citations: [],
  followUps: [],
};

function toAnswerView(payload: IntelligenceResponse): AnswerView {
  const a = payload.answer;
  return {
    headline: a.headline,
    sections: a.sections ?? [],
    evidence: a.evidence ?? [],
    limitations: a.limitations ?? [],
    citations: a.citations ?? [],
    followUps: a.followUps ?? [],
    ...(a.phrasedBy ? { phrasedBy: a.phrasedBy } : null),
  };
}

function toMeta(payload: IntelligenceResponse): AnswerMeta {
  return {
    mode: payload.mode,
    modelRequested: payload.model?.requested ?? false,
    modeLabel: payload.modeLabel,
    latencyMs: payload.latencyMs,
    grounding: {
      status: payload.grounding?.status ?? "unknown",
      checked: payload.grounding?.checked ?? null,
      ungrounded: payload.grounding?.ungrounded ?? [],
    },
    model: payload.model,
    region: payload.region,
    bbox: payload.bbox,
    window: payload.window,
    transport: "json",
  };
}

async function readError(res: Response): Promise<IntelligenceError> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail?: unknown }).detail;
      if (typeof d === "string") detail = d;
    }
  } catch {
    /* non-JSON body */
  }
  return new IntelligenceError(detail, res.status);
}

export function useIntelligence() {
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<AnswerView | null>(null);
  const [partialMeta, setPartialMeta] = useState<Partial<AnswerMeta> | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStreaming(false);
    setPartial(null);
    setPartialMeta(null);
  }, []);

  const postJson = useCallback(async (body: Record<string, unknown>, signal: AbortSignal) => {
    const res = await fetch("/api/intelligence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as IntelligenceResponse;
  }, []);

  const postJsonDirect = useCallback(
    async (body: Record<string, unknown>, signal: AbortSignal) => {
      const base = directEngineBase();
      if (!base) throw new IntelligenceError("No direct engine address on this host", 0);
      const res = await fetch(`${base}/api/intelligence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw await readError(res);
      return (await res.json()) as IntelligenceResponse;
    },
    [],
  );

  /** Stream the deterministic answer and assemble it frame by frame. */
  const runStream = useCallback(
    async ({
      body,
      signal,
      onPartial,
    }: {
      body: Record<string, unknown>;
      signal: AbortSignal;
      onPartial?: RequestOptions["onPartial"];
    }): Promise<IntelligenceTurnResult> => {
      const res = await fetch("/api/intelligence/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, mode: "deterministic" }),
        signal,
      });
      if (!res.ok) throw await readError(res);
      if (!res.body) throw new IntelligenceError("The stream had no body", 500);

      let view: AnswerView = { ...EMPTY_ANSWER };
      let meta: Partial<AnswerMeta> = { mode: "deterministic", transport: "stream" };
      setStreaming(true);

      const publish = () => {
        const snapshot: AnswerView = {
          ...view,
          sections: [...view.sections],
          evidence: [...view.evidence],
          limitations: [...view.limitations],
          citations: [...view.citations],
        };
        setPartial(snapshot);
        setPartialMeta({ ...meta });
        onPartial?.(snapshot, meta);
      };

      const apply = (event: StreamEvent) => {
        switch (event.type) {
          case "meta":
            meta = {
              ...meta,
              mode: event.mode === "llm" ? "llm" : "deterministic",
              model: event.model,
              region: event.region,
              window: event.window,
            };
            break;
          case "headline":
            view = { ...view, headline: event.text };
            break;
          case "section":
            view = { ...view, sections: [...view.sections, { title: event.title, body: event.body }] };
            break;
          case "evidence":
            view = { ...view, evidence: event.items };
            break;
          case "limitations":
            view = { ...view, limitations: event.items };
            break;
          case "citations":
            view = { ...view, citations: event.items };
            break;
          case "done":
            meta = {
              ...meta,
              latencyMs: event.latencyMs,
              grounding: event.grounding,
              modeLabel: "Deterministic evidence engine (streamed)",
            };
            break;
        }
        publish();
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            apply(JSON.parse(line.slice(5).trim()) as StreamEvent);
          } catch {
            /* a partial or unknown frame is not an error */
          }
        }
      }

      setStreaming(false);
      setPartial(null);
      setPartialMeta(null);

      return {
        // The stream never sends follow-ups; they are dropped rather than invented.
        answer: { ...view, followUps: [] },
        meta: {
          mode: meta.mode ?? "deterministic",
          modeLabel: meta.modeLabel ?? "Deterministic evidence engine",
          latencyMs: meta.latencyMs ?? 0,
          grounding: meta.grounding ?? { status: "not_applicable", checked: 0, ungrounded: [] },
          model:
            meta.model ?? {
              provider: "unknown",
              available: false,
              model: null,
              note: "The stream did not report a model.",
            },
          region: meta.region ?? "unknown",
          bbox: [],
          window: meta.window ?? { start: null, end: null },
          transport: "stream",
        },
      };
    },
    [],
  );

  const ask = useCallback(
    async ({ question, region, start, end, mode, onPartial }: RequestOptions): Promise<IntelligenceTurnResult> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setPartial(null);
      setPartialMeta(null);

      const body: Record<string, unknown> = {
        question,
        region,
        start: start ?? null,
        end: end ?? null,
        mode,
      };

      /**
       * The engine's `latencyMs` is not the user's wait: for a JSON answer the
       * engine starts its clock *after* the deterministic computation, so a
       * 2.5 s round trip can report 125 ms. Recording the browser's own elapsed
       * time keeps both numbers visible instead of quietly showing only the
       * flattering one.
       */
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const stamp = (r: IntelligenceTurnResult): IntelligenceTurnResult => ({
        ...r,
        meta: {
          ...r.meta,
          wallMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
        },
      });

      try {
        /* ---- deterministic: stream the engine's own sections ---- */
        if (mode === "deterministic") {
          try {
            return stamp(await runStream({ body, signal: controller.signal, onPartial }));
          } catch (streamError) {
            if (controller.signal.aborted) throw streamError;
            // The stream endpoint did not work — say so and use the JSON path.
            const payload = await postJson({ ...body, mode: "deterministic" }, controller.signal);
            return stamp({
              answer: toAnswerView(payload),
              meta: {
                ...toMeta(payload),
                modeLabel: `${payload.modeLabel} · stream unavailable, single response used`,
              },
            });
          }
        }

        /* ---- auto / llm: one JSON response ---- */
        try {
          const payload = await postJson(body, controller.signal);
          return stamp({ answer: toAnswerView(payload), meta: toMeta(payload) });
        } catch (error) {
          const err = error as IntelligenceError;
          if (controller.signal.aborted) throw error;

          if (err.status === 503) {
            // Model unavailable: this build already degrades to the deterministic
            // analyst, but if a future build answers 503 we retry and say so.
            const payload = await postJson({ ...body, mode: "deterministic" }, controller.signal);
            return {
              answer: toAnswerView(payload),
              meta: {
                ...toMeta(payload),
                modeLabel: `${payload.modeLabel} · local model unavailable (HTTP 503)`,
              },
            };
          }

          if (err.status >= 500) {
            // A local-model answer takes ~40 s in the engine and the same-origin
            // dev proxy drops anything slower than ~32 s (measured; see
            // PHASE_3_AUDIT.md §4.4). Try the engine directly on loopback first so
            // the model path stays usable in this environment, then fall back to
            // the deterministic stream.
            const direct = directEngineBase();
            if (direct) {
              try {
                const payload = await postJsonDirect(body, controller.signal);
                return stamp({
                  answer: toAnswerView(payload),
                  meta: {
                    ...toMeta(payload),
                    transport: "json-direct",
                    modeLabel: `${payload.modeLabel} · direct engine connection (same-origin proxy dropped the response: HTTP ${err.status})`,
                  },
                });
              } catch {
                /* fall through to the streamed deterministic answer */
              }
            }

            // Measured failure mode: streamed transport reaches the same engine
            // and answers in ~13 s, so retry once through it and label the result
            // as a fallback instead of pretending a model phrased it.
            const fallback = await runStream({
              body: { ...body, mode: "deterministic" },
              signal: controller.signal,
              onPartial,
            });
            return stamp({
              answer: fallback.answer,
              meta: {
                ...fallback.meta,
                modeLabel: `${fallback.meta.modeLabel} · fallback after HTTP ${err.status} on the model request`,
              },
            });
          }
          throw error;
        }
      } finally {
        setStreaming(false);
        setBusy(false);
        setPartial(null);
        setPartialMeta(null);
        abortRef.current = null;
      }
    },
    [postJson, postJsonDirect, runStream],
  );

  return { ask, cancel, busy, streaming, partial, partialMeta };
}
