/**
 * AOI verdict for "Ask the Earth".
 *
 * The single hard rule of this platform is that an empty result is not evidence
 * of absence. So the page never renders "0 detections" on its own: it renders a
 * verdict whose wording is licensed by the *delivery* record, and every verdict
 * carries the evidence string the engine produced.
 *
 * All inputs come from the engine:
 *   - `totalDetections`, `dataDays`      → /api/summary
 *   - per-day `state` / `available`      → /api/calendar (already scoped to the bbox)
 *   - per-sensor `evidence` / `basis`    → /api/day/{date}
 *
 * This module is pure (no React, no fetch) so it can be unit-tested with a plain
 * Node script; see PHASE_4_TEST_REPORT.md.
 */

export type AoiVerdict =
  | "detections"
  | "confirmed-zero"
  | "partial"
  | "unknown"
  | "unavailable";

export interface CalendarDayLike {
  date: string;
  state: string; // observed | observed_zero | partial | unknown | unavailable
  available: boolean;
  /** Null when the day has no coverage evidence (missing is not zero). */
  total: number | null;
  sensors?: Record<string, { state?: string; count?: number; evidence?: string }>;
}

export interface Verdict {
  verdict: AoiVerdict;
  /** Uppercase banner text. Exact wording is part of the scientific contract. */
  label: string;
  /** One sentence a reader can quote, with no implication beyond the evidence. */
  detail: string;
  /** Engine strings (evidence / basis), rendered verbatim. */
  evidence: string[];
  /** Days in the requested window with no delivery evidence. */
  missingDates: string[];
  /** Days in the requested window with a delivered product. */
  deliveredDates: string[];
  /** True only for `confirmed-zero`: the one case where a zero may be stated. */
  zeroIsLicensed: boolean;
}

export interface ClassifyInput {
  totalDetections: number;
  /** Calendar days already restricted to the covered window by the caller. */
  windowDays: CalendarDayLike[];
  coverageFirst: string | null;
  coverageLast: string | null;
  /** Optional per-sensor evidence for the most recent delivered day. */
  dayEvidence?: Record<string, { evidence?: string; basis?: string; state?: string }> | null;
}

const LABELS: Record<AoiVerdict, string> = {
  detections: "DETECTIONS RECORDED",
  "confirmed-zero": "COVERAGE CONFIRMED — ZERO DETECTIONS",
  partial: "COVERAGE PARTIAL — NOT A ZERO",
  unknown: "COVERAGE UNKNOWN",
  unavailable: "PRODUCT UNAVAILABLE",
};

export function classifyAoi(input: ClassifyInput): Verdict {
  const { totalDetections, windowDays, coverageFirst, coverageLast } = input;
  const delivered = windowDays.filter((d) => d.available).map((d) => d.date);
  const missing = windowDays.filter((d) => !d.available).map((d) => d.date);
  const unavailable = windowDays.filter((d) => d.state === "unavailable").map((d) => d.date);

  const evidence: string[] = [];
  if (input.dayEvidence) {
    for (const [sensor, row] of Object.entries(input.dayEvidence)) {
      if (row?.evidence) evidence.push(`${sensor.toUpperCase()} · ${row.evidence}`);
    }
  }

  const windowLabel =
    coverageFirst && coverageLast ? `${coverageFirst} → ${coverageLast}` : "the stored window";

  if (totalDetections > 0) {
    return {
      verdict: "detections",
      label: LABELS.detections,
      detail:
        `The selected area reported ${totalDetections.toLocaleString("en-US")} detections inside ${windowLabel}. ` +
        "A thermal anomaly is not a confirmed wildfire: the engine reports what a sensor retrieved.",
      evidence,
      missingDates: missing,
      deliveredDates: delivered,
      zeroIsLicensed: false,
    };
  }

  if (windowDays.length === 0) {
    return {
      verdict: "unknown",
      label: LABELS.unknown,
      detail:
        "No day in the stored window could be resolved for this area, so the result is not a zero. " +
        "Nothing about fire activity here can be stated either way.",
      evidence,
      missingDates: missing,
      deliveredDates: delivered,
      zeroIsLicensed: false,
    };
  }

  if (unavailable.length === windowDays.length) {
    return {
      verdict: "unavailable",
      label: LABELS.unavailable,
      detail:
        "Every requested sensor-day failed at the source, so the area has no usable measurement. " +
        "This is a data failure, not a fire-free area.",
      evidence,
      missingDates: missing,
      deliveredDates: delivered,
      zeroIsLicensed: false,
    };
  }

  if (delivered.length === windowDays.length) {
    return {
      verdict: "confirmed-zero",
      label: LABELS["confirmed-zero"],
      detail:
        `All ${windowDays.length} days in ${windowLabel} have product-delivery evidence and none reported ` +
        "a detection in this area. This is a conditional zero: delivery is proved globally per sensor-day, " +
        "which does not prove the area itself was cloud-free at overpass time.",
      evidence,
      missingDates: missing,
      deliveredDates: delivered,
      zeroIsLicensed: true,
    };
  }

  if (delivered.length > 0) {
    return {
      verdict: "partial",
      label: LABELS.partial,
      detail:
        `${delivered.length} of ${windowDays.length} days have delivery evidence and reported nothing here; ` +
        `${missing.length} day${missing.length === 1 ? " has" : "s have"} no delivery evidence. ` +
        "A partial record cannot be read as zero activity.",
      evidence,
      missingDates: missing,
      deliveredDates: delivered,
      zeroIsLicensed: false,
    };
  }

  return {
    verdict: "unknown",
    label: LABELS.unknown,
    detail:
      "The product delivery for this area cannot be established, so the empty result means nothing. " +
      "Unknown coverage is not zero detections.",
    evidence,
    missingDates: missing,
    deliveredDates: delivered,
    zeroIsLicensed: false,
  };
}

/** Days of the calendar payload that fall inside the stored coverage window. */
export function windowDays<T extends { date: string }>(
  days: T[],
  first: string | null,
  last: string | null,
): T[] {
  if (!first || !last) return [];
  return days.filter((d) => d.date >= first && d.date <= last);
}

export const VERDICT_TONE: Record<AoiVerdict, "ok" | "ember" | "muted" | "cyan"> = {
  detections: "ember",
  "confirmed-zero": "ok",
  partial: "cyan",
  unknown: "muted",
  unavailable: "muted",
};
