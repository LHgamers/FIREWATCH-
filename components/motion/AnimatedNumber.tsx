"use client";

/**
 * AnimatedNumber
 * --------------
 * Interpolates between two *real* numbers when a value changes.
 *
 * Honesty constraints baked in:
 *
 *  - It never invents a value. The animation starts from the previous value it
 *    rendered and always lands exactly on `value`.
 *  - `null` / `undefined` render the fallback ("—"). An unknown quantity is
 *    never animated to zero, and a zero is never animated up from nothing.
 *  - Integers stay integers on every frame (a detection count must never read
 *    "12,847.4").
 *  - On first render the value is shown immediately, so the number a server
 *    render or a cached payload produced is never replaced by a wrong one.
 *  - Reduced motion (CSS or OS) shows the value with no interpolation.
 */

import { useAnimatedNumber } from "@/lib/motion";
import "./motion.css";

function defaultFormat(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

export function AnimatedNumber({
  value,
  format = defaultFormat,
  fallback = "—",
  className,
  duration,
  disabled,
}: {
  value: number | null | undefined;
  format?: (v: number) => string;
  fallback?: string;
  className?: string;
  duration?: number;
  disabled?: boolean;
}) {
  const target = typeof value === "number" && Number.isFinite(value) ? value : null;
  const display = useAnimatedNumber(target, { duration, disabled });

  if (display === null || target === null) {
    return <span className={["fw-counter", className].filter(Boolean).join(" ")}>{fallback}</span>;
  }
  return (
    <span className={["fw-counter", className].filter(Boolean).join(" ")}>{format(display)}</span>
  );
}
