"use client";

/**
 * MotionRoot
 * ----------
 * The JavaScript half of the reduced-motion contract.
 *
 * It reflects the effective motion preference onto `<html data-motion="on|off">`:
 * the user's choice from the settings page first, then
 * `(prefers-reduced-motion: reduce)`. CSS in motion.css — and any rule the app
 * adds later — can then disable animation from one attribute, which also covers
 * animations that start before hydration.
 *
 * It renders nothing and owns no DOM of its own, so it is safe to mount once in
 * the root layout above the router outlet.
 */

import { useEffect } from "react";
import "./motion.css";
import {
  MOTION_PREF_EVENT,
  REDUCED_MOTION_QUERY,
  motionEnabledNow,
  readMotionPref,
} from "@/lib/motion";

export function MotionRoot() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const apply = () => {
      root.dataset.motion = motionEnabledNow() ? "on" : "off";
      root.dataset.motionPref = readMotionPref();
    };
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

  return null;
}
