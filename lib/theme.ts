"use client";

/**
 * Theme primitives + chart token bridge.
 *
 * `useChartTokens` uses React state, so this module is explicitly a Client Component
 * module — Next's RSC boundary checker rejects hook imports anywhere in the server
 * graph, so `"use client"` is required as soon as a Server Component imports anything
 * from here (including the `THEME_INIT_SCRIPT` string used by `app/layout.tsx`).
 * That import is verified working in dev; if a future Next version proxies client-module
 * exports on the server, inline the literal snippet from the handover notes instead and
 * drop the import.
 *
 * Nothing here reads `window` during render, so SSR output stays deterministic.
 *
 * Palette values live in `app/globals.css` as space-separated RGB triples. Charts
 * (recharts / SVG / MapLibre) cannot resolve `rgb(var(--x))` themselves, so they
 * read the *computed* triples from `document.documentElement` and get plain CSS
 * colour strings back.
 */

import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** localStorage key — shared by ThemeProvider, the pre-paint script and cross-tab sync. */
export const THEME_STORAGE_KEY = "firewatch.theme";
/** Attribute that carries the *resolved* theme ("light" | "dark") on <html>. */
export const THEME_ATTRIBUTE = "data-theme";
/** Attribute that carries the user *preference* ("light" | "dark" | "system") on <html>. */
export const THEME_PREF_ATTRIBUTE = "data-theme-pref";
/** Window event fired by ThemeProvider after the palette has been applied. */
export const THEME_EVENT = "firewatch:themechange";

/**
 * Pre-paint script for `app/layout.tsx`.
 *
 * Place as the last child of <head>, e.g.
 * `<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />`.
 * Default preference is "light" (the product ships white-first); "dark" and "system"
 * are explicit choices. It sets data-theme, data-theme-pref and color-scheme before the
 * first paint, and marks the intro gate before the app shell can paint. It is synchronous
 * (no src/async) so it runs during head parsing; theme storage access is wrapped in try/catch
 * for private browsing modes where localStorage access throws.
 */
export const THEME_INIT_SCRIPT = `(function(){var r=document.documentElement;if(new URLSearchParams(window.location.search).get("intro")!=="0")r.dataset.intro="playing";try{var k="${THEME_STORAGE_KEY}",s=localStorage.getItem(k),m=window.matchMedia("(prefers-color-scheme: dark)").matches,p=(s==="light"||s==="dark"||s==="system")?s:"light",t=p==="system"?(m?"dark":"light"):p;r.setAttribute("${THEME_ATTRIBUTE}",t);r.setAttribute("${THEME_PREF_ATTRIBUTE}",p);r.style.colorScheme=t;}catch(e){}})();`;

export type ChartTokens = {
  /** Chart grid lines — maps to --line */
  grid: string;
  /** Axis ticks / labels — maps to --muted */
  axis: string;
  /** Tooltip surface — maps to --panel */
  tooltipBg: string;
  /** Tooltip hairline — maps to --line */
  tooltipBorder: string;
  ink: string;
  muted: string;
  cyan: string;
  ember: string;
  ok: string;
  fire: string;
};

/** Dark-theme fallbacks, used during SSR and if a variable is missing/unparsable. */
export const DARK_CHART_TOKENS: ChartTokens = {
  grid: "rgb(34, 48, 74)",
  axis: "rgb(145, 162, 185)",
  tooltipBg: "rgb(19, 30, 48)",
  tooltipBorder: "rgb(34, 48, 74)",
  ink: "rgb(241, 245, 252)",
  muted: "rgb(145, 162, 185)",
  cyan: "rgb(57, 200, 242)",
  ember: "rgb(255, 157, 66)",
  ok: "rgb(64, 214, 160)",
  fire: "rgb(255, 99, 61)",
};

const TOKEN_VARS: Record<keyof ChartTokens, string> = {
  grid: "--line",
  axis: "--muted",
  tooltipBg: "--panel",
  tooltipBorder: "--line",
  ink: "--ink",
  muted: "--muted",
  cyan: "--cyan",
  ember: "--ember",
  ok: "--ok",
  fire: "--fire",
};

const TOKEN_KEYS = Object.keys(TOKEN_VARS) as (keyof ChartTokens)[];

/** `"19 30 48"` (or `"19, 30, 48"`) → `"rgb(19, 30, 48)"`. Returns `fallback` if unparsable. */
function toCssColor(raw: string, fallback: string): string {
  const parts = raw.trim().split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return `rgb(${parts.map((n) => Math.round(n)).join(", ")})`;
}

/**
 * Read the active palette from the document. Safe on the server (returns dark tokens).
 * Call this inside chart render functions / effects, not at module scope.
 */
export function chartTokens(): ChartTokens {
  if (typeof window === "undefined" || typeof document === "undefined") return DARK_CHART_TOKENS;
  const styles = window.getComputedStyle(document.documentElement);
  const tokens = { ...DARK_CHART_TOKENS };
  for (const key of TOKEN_KEYS) {
    tokens[key] = toCssColor(styles.getPropertyValue(TOKEN_VARS[key]), DARK_CHART_TOKENS[key]);
  }
  return tokens;
}

function sameTokens(a: ChartTokens, b: ChartTokens): boolean {
  return TOKEN_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Chart palette that re-reads itself whenever the theme changes: attribute flips,
 * the provider's custom event, and OS-level preference changes are all covered.
 * Client-only (uses React state).
 */
export function useChartTokens(): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(DARK_CHART_TOKENS);

  useEffect(() => {
    const sync = () => {
      const next = chartTokens();
      setTokens((prev) => (sameTokens(prev, next) ? prev : next));
    };
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [THEME_ATTRIBUTE],
    });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", sync);
    window.addEventListener(THEME_EVENT, sync);

    return () => {
      observer.disconnect();
      media.removeEventListener?.("change", sync);
      window.removeEventListener(THEME_EVENT, sync);
    };
  }, []);

  return tokens;
}
