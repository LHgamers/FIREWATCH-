"use client";

/**
 * PageTransition
 * --------------
 * A route-level entrance: fade + 10 px rise, 420 ms, opacity/transform only.
 *
 * It is deliberately *not* an exit animation. Measured on the running app: an
 * exit transition would delay the new route by its own duration on a data
 * driven page whose first paint is already waiting on the engine, and the
 * whole point of this product is that the numbers arrive as fast as possible.
 *
 * Without JavaScript the wrapper still renders its children in the final
 * state — the animation is a CSS class, not a state machine.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import "./motion.css";

/** Routes whose first paint is a canvas: a transform on an ancestor would make
 *  MapLibre / WebGL pay for a compositing layer they do not need, so these are
 *  left unwrapped (no extra DOM at all). */
const NO_TRANSITION = ["/map", "/ask"];

export function PageTransition({
  children,
  className,
  /** Disable the entrance entirely (e.g. inside an already-animated shell). */
  disabled = false,
  /** Extra path prefixes to leave unwrapped. */
  disabledOn = [],
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  disabledOn?: string[];
}) {
  const pathname = usePathname() ?? "";
  const skip =
    disabled ||
    [...NO_TRANSITION, ...disabledOn].some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (skip) return <>{children}</>;
  return (
    <div key={pathname} className={["fw-page", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
