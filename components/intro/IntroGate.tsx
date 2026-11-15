"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CinematicIntro } from "./CinematicIntro";
import { getIntroMuted, prefersReducedMotion, setIntroMuted, shouldPlayIntro } from "@/lib/intro-prefs";

/**
 * Owns when the cinematic runs (every load) and the prefs around it.
 * The sequence itself lives in ./CinematicIntro (visuals + original audio).
 */
export function IntroGate() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(true);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setMuted(getIntroMuted());
    // ?motion=1 forces the full sequence even when the OS asks for reduced motion
    // (useful for demos and for verifying the 3D path).
    const forcedMotion = new URLSearchParams(window.location.search).get("motion") === "1";
    setReduced(forcedMotion ? false : prefersReducedMotion());
    if (shouldPlayIntro()) {
      setActive(true);
      document.body.style.overflow = "hidden";
      // The pre-paint marker hides the shell and holds content entrances for
      // the dashboard reveal after the cinematic.
      document.documentElement.dataset.intro = "playing";
    }
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    document.body.style.overflow = "";
    document.documentElement.dataset.intro = "complete";
    if (typeof window !== "undefined" && window.location.search.includes("intro=")) {
      router.replace(window.location.pathname, { scroll: false });
    }
  }, [router]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      setIntroMuted(next);
      return next;
    });
  }, []);

  if (!active) return null;

  return (
    <CinematicIntro
      muted={muted}
      onToggleMute={toggleMute}
      onComplete={finish}
      reducedMotion={reduced}
    />
  );
}
