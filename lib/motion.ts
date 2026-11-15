"use client";

/**
 * FIREWATCH motion runtime.
 *
 * Design rules (see components/motion/motion.css and MOTION_DESIGN_SYSTEM.md):
 *
 *  1. CSS first. Every animation in this file is a *timing* helper for CSS
 *     `animation` / `transition` declarations — no layout properties, only
 *     `opacity` and `transform`, so the compositor does the work.
 *  2. `prefers-reduced-motion` is honoured twice: in CSS
 *     (`@media (prefers-reduced-motion: reduce)`) and in JavaScript (this
 *     module), so imperative animations (counters, timers) also stop.
 *  3. No fake state. Nothing here invents elapsed time, progress or a value:
 *     `useAnimatedNumber` interpolates between two *real* numbers and always
 *     lands exactly on the value it was given.
 *  4. Works without JavaScript. Every reveal/animation is a CSS class that
 *     renders the final state if no script ever runs.
 */

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

export const MOTION = {
  /** Micro feedback: press states, toggles. */
  fast: 140,
  /** Default UI transition. */
  base: 220,
  /** Page / section entrance. */
  slow: 420,
  /** Value interpolation ceiling. Longer than this and the number stops
   *  reading as a transition and starts reading as a different value. */
  counter: 620,
  /** Maximum stagger step; a 40-row list must not take four seconds. */
  staggerMax: 240,
  easing: {
    standard: "cubic-bezier(0.16, 1, 0.3, 1)",
    inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
    out: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  /** Distance tokens, in px. Small on purpose: fire data is the subject,
   *  not the choreography. */
  distance: { sm: 6, md: 10, lg: 16 },
} as const;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/* ------------------------------------------------------------------ */
/* User preference (settings page)                                    */
/* ------------------------------------------------------------------ */

/**
 * `"system"` follows the OS, `"full"` forces motion on, `"reduced"` forces it
 * off. Stored per browser. This can only ever *reduce* motion against the OS
 * preference when the user asks for it; it never silently overrides a
 * `prefers-reduced-motion: reduce` that the user did not choose to change.
 */
export type MotionPref = "system" | "full" | "reduced";

export const MOTION_PREF_KEY = "fw:motion-pref";
/** Same-tab change notification; `storage` only fires in other tabs. */
export const MOTION_PREF_EVENT = "fw:motion-pref-change";

export function readMotionPref(): MotionPref {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(MOTION_PREF_KEY);
    return raw === "full" || raw === "reduced" ? raw : "system";
  } catch {
    return "system";
  }
}

export function writeMotionPref(pref: MotionPref): void {
  if (typeof window === "undefined") return;
  try {
    if (pref === "system") window.localStorage.removeItem(MOTION_PREF_KEY);
    else window.localStorage.setItem(MOTION_PREF_KEY, pref);
  } catch {
    /* private mode: the choice simply does not persist */
  }
  window.dispatchEvent(new Event(MOTION_PREF_EVENT));
}

/* ------------------------------------------------------------------ */
/* Media query                                                        */
/* ------------------------------------------------------------------ */

/**
 * Synchronous read. Safe on the server (returns `false` there, matching the
 * optimistic CSS default: content is visible and static).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Reactive `prefers-reduced-motion`. Starts `false` for hydration parity, then
 * follows the real preference (and any live OS change).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const apply = () => setReduced(mql.matches);
    apply();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
    // Safari < 14
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, []);

  return reduced;
}

/**
 * The single source of truth for "should imperative animation run?".
 *
 * Order of precedence: explicit user choice → OS preference → motion on.
 * `false` on the server so markup renders in its final state.
 */
export function motionEnabledNow(): boolean {
  const pref = readMotionPref();
  if (pref === "full") return true;
  if (pref === "reduced") return false;
  return !prefersReducedMotion();
}

/** Reactive `motionEnabledNow()`, including live pref changes from another tab. */
export function useMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const apply = () => setEnabled(motionEnabledNow());
    apply();
    window.addEventListener(MOTION_PREF_EVENT, apply);
    window.addEventListener("storage", apply);
    let mql: MediaQueryList | null = null;
    if (typeof window.matchMedia === "function") {
      mql = window.matchMedia(REDUCED_MOTION_QUERY);
      if (typeof mql.addEventListener === "function") mql.addEventListener("change", apply);
      else mql.addListener(apply);
    }
    return () => {
      window.removeEventListener(MOTION_PREF_EVENT, apply);
      window.removeEventListener("storage", apply);
      if (mql) {
        if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", apply);
        else mql.removeListener(apply);
      }
    };
  }, []);

  return enabled;
}

/* ------------------------------------------------------------------ */
/* Chart motion                                                       */
/* ------------------------------------------------------------------ */

export interface ChartMotion {
  /** Recharts `isAnimationActive`. False until the client knows the pref. */
  isAnimationActive: boolean;
  animationDuration: number;
  animationBegin: number;
  animationEasing: "ease-out";
}

/**
 * Recharts animation props that obey the same preference as CSS motion.
 *
 * Recharts animates SVG paths and rects imperatively, so the CSS kill switch in
 * motion.css cannot stop it — the preference has to be passed as props. The
 * hook returns `isAnimationActive: false` on the server and on the first client
 * render (matching what CSS does with `data-motion`), so a chart never draws a
 * transition it is about to disable.
 */
export function useChartMotion({
  duration = 700,
  begin = 80,
}: { duration?: number; begin?: number } = {}): ChartMotion {
  const enabled = useMotionEnabled();
  return {
    isAnimationActive: enabled,
    animationDuration: duration,
    animationBegin: begin,
    animationEasing: "ease-out",
  };
}

/**
 * The series-level variant: the second area/bar arrives slightly after the
 * first so the two sensors read as two data streams, not one blob.
 */
export function useSeriesMotion(index: number): ChartMotion {
  return useChartMotion({ duration: 760, begin: 80 + index * 120 });
}

/* ------------------------------------------------------------------ */
/* Stagger                                                            */
/* ------------------------------------------------------------------ */

/** Clamp a list index to a stagger delay in ms. */
export function stagger(index: number, step = 45, max = MOTION.staggerMax): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(index * step, max);
}

/* ------------------------------------------------------------------ */
/* IntersectionObserver reveal                                        */
/* ------------------------------------------------------------------ */

export type RevealState = "initial" | "armed" | "in";

interface InViewOptions {
  /** Fire once and stay revealed. Default true. */
  once?: boolean;
  /** Fraction of the element that must be visible. */
  amount?: number;
  rootMargin?: string;
  /** Skip the observer entirely (e.g. already-visible hero content). */
  disabled?: boolean;
}

/**
 * Reveal state machine used by <RevealSection>.
 *
 * The element is *visible by default* (`initial`). Only after mount does it
 * become `armed` (hidden, ready to animate) — and only if it is still below the
 * fold at that moment, so nothing that is already on screen can flash. If no
 * JavaScript runs, the element stays `initial`: fully visible, no animation.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>({
  once = true,
  amount = 0.12,
  rootMargin = "0px 0px -8% 0px",
  disabled = false,
}: InViewOptions = {}) {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState<RevealState>("initial");

  // Arm only if the element is still below the fold. Nothing that is already
  // on screen is ever hidden, so there is no flash on load.
  useEffect(() => {
    if (disabled) return;
    if (prefersReducedMotion()) return;
    if (typeof IntersectionObserver !== "function") return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewport = window.innerHeight || document.documentElement.clientHeight;
    const alreadyVisible = rect.top < viewport * 0.94 && rect.bottom > 0;
    if (alreadyVisible) return;
    setState("armed");
  }, [disabled]);

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState("in");
            if (once) observer.disconnect();
          } else if (!once) {
            setState("armed");
          }
        }
      },
      { threshold: amount, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [amount, disabled, once, rootMargin]);

  return { ref, state };
}

/* ------------------------------------------------------------------ */
/* Animated number                                                    */
/* ------------------------------------------------------------------ */

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Interpolate between two real values.
 *
 * - `null` in, `null` out (unknown stays unknown — never animates to zero).
 * - Reduced motion → returns the target immediately.
 * - Integer targets are rendered as integers at every frame, so a count is
 *   never displayed as a fraction and never over- or undershoots.
 * - The first value rendered is the target (no animation on mount) so a
 *   server-rendered/pre-hydration number is never replaced by a wrong one.
 */
export function useAnimatedNumber(
  target: number | null,
  { duration = MOTION.counter, disabled = false }: { duration?: number; disabled?: boolean } = {},
): number | null {
  const [display, setDisplay] = useState<number | null>(target);
  const fromRef = useRef<number | null>(target);
  const displayRef = useRef<number | null>(target);
  const frameRef = useRef<number | null>(null);

  displayRef.current = display;

  useEffect(() => {
    if (target === null) {
      fromRef.current = null;
      setDisplay(null);
      return;
    }
    const from = fromRef.current ?? displayRef.current;
    if (from === null || disabled || duration <= 0 || prefersReducedMotion() || Math.abs(target - from) < 1e-9) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const isInteger = Number.isInteger(target) && Number.isInteger(from);
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const value = from + (target - from) * easeOutCubic(t);
      setDisplay(t >= 1 ? target : isInteger ? Math.round(value) : value);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      fromRef.current = target;
    };
  }, [target, duration, disabled]);

  return display;
}

/* ------------------------------------------------------------------ */
/* Utility: clamp a delay to something sane                           */
/* ------------------------------------------------------------------ */

export function clampDelay(delay: number | undefined, max = 1200): number {
  if (!delay || !Number.isFinite(delay) || delay < 0) return 0;
  return Math.min(delay, max);
}
