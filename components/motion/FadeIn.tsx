"use client";

/**
 * FadeIn
 * ------
 * Entrance on mount (no observer): opacity only, optional delay. Used for
 * things that appear in response to a user action — a result card, an error
 * banner, a streamed answer block — where a scroll observer would be wrong
 * because the element is already on screen.
 */

import type { ReactNode } from "react";
import { clampDelay } from "@/lib/motion";
import "./motion.css";

export function FadeIn({
  children,
  className,
  delay = 0,
  /** "fade" = opacity only, "rise" = opacity + 10 px, "rise-sm" = + 6 px. */
  variant = "rise",
  duration,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  variant?: "fade" | "rise" | "rise-sm";
  /** Override duration in ms (defaults: fade 320, rise 380, rise-sm 260). */
  duration?: number;
}) {
  const cls = variant === "fade" ? "fw-fade-in" : variant === "rise-sm" ? "fw-rise-in-sm" : "fw-rise-in";
  return (
    <div
      className={[cls, className].filter(Boolean).join(" ")}
      style={
        {
          "--fw-delay": `${clampDelay(delay)}ms`,
          ...(duration ? { animationDuration: `${duration}ms` } : null),
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
