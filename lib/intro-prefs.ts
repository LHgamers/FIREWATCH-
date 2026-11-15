const MUTED_KEY = "firewatch.intro.muted";

/**
 * The cinematic runs on every document load (every reload and every fresh navigation),
 * so a returning visitor still gets the opening. `?intro=0` is the opt-out used by
 * automation and by anyone who wants the still view; it is never persisted.
 */
export function shouldPlayIntro(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("intro") !== "0";
}

export function getIntroMuted(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(MUTED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setIntroMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
