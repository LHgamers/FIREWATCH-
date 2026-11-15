/**
 * Local view types for the Intelligence workspace.
 *
 * These are deliberately *not* in lib/types.ts (owned by the orchestrator).
 * They mirror the engine contract that was read from engine/app/analyst.py and
 * verified against the running engine:
 *
 *   POST /api/intelligence          → IntelligenceResponse (lib/types.ts)
 *   POST /api/intelligence/stream   → SSE frames: meta, headline, section,
 *                                     evidence, limitations, citations, done
 *
 * Knowing both shapes lets the page render one component for either transport.
 */

import type { AiStatus, Citation, EvidenceItem } from "@/lib/types";

export type IntelMode = "auto" | "deterministic" | "llm";

export interface SectionView {
  title: string;
  body: string[];
}

/** Transport-independent answer, built from JSON or from streamed frames. */
export interface AnswerView {
  headline: string;
  sections: SectionView[];
  evidence: EvidenceItem[];
  limitations: string[];
  citations: Citation[];
  followUps: string[];
  /** Present only when the local model rephrased the evidence. */
  phrasedBy?: string;
}

export interface GroundingView {
  status: string;
  checked: number | null;
  ungrounded: string[];
}

export interface AnswerMeta {
  mode: "llm" | "deterministic";
  modeLabel: string;
  latencyMs: number;
  grounding: GroundingView;
  model: AiStatus;
  region: string;
  bbox: [number, number, number, number] | number[];
  window: { start: string | null; end: string | null };
  /**
   * "stream"        = SSE frames arrived progressively
   * "json"          = one same-origin POST /api/intelligence response
   * "json-direct"   = one response from the loopback engine after the dev proxy
   *                   dropped the same request (labelled in the UI)
   */
  transport: "stream" | "json" | "json-direct";
  /** True when this answer used a model named by the request, not the env default. */
  modelRequested?: boolean;
  /** Browser-measured round trip, including the engine's own computation. */
  wallMs?: number;
}

export interface IntelligenceTurnResult {
  answer: AnswerView;
  meta: AnswerMeta;
}

/** One frame of POST /api/intelligence/stream. */
export type StreamEvent =
  | { type: "meta"; mode: string; model: AiStatus; region: string; window: { start: string | null; end: string | null } }
  | { type: "headline"; text: string }
  | { type: "section"; title: string; body: string[] }
  | { type: "evidence"; items: EvidenceItem[] }
  | { type: "limitations"; items: string[] }
  | { type: "citations"; items: Citation[] }
  | { type: "done"; latencyMs: number; grounding: GroundingView };

export class IntelligenceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IntelligenceError";
    this.status = status;
  }
}
