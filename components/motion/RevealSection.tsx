"use client";

/**
 * RevealSection
 * -------------
 * Scroll-triggered entrance for a block of content (one panel, one row of
 * cards, one section). Uses IntersectionObserver, animates opacity + 10 px of
 * translateY, and renders fully visible when JavaScript never runs.
 *
 * The `delay` prop is a stagger offset in milliseconds, clamped by
 * `clampDelay()` so a long list cannot accumulate into a multi-second wait.
 */

import type { ElementType, ReactNode } from "react";
import { clampDelay, useReveal } from "@/lib/motion";
import "./motion.css";

export function RevealSection({
  children,
  className,
  /** Stagger offset in ms. */
  delay = 0,
  as: Tag = "div",
  /** Reveal every time it enters the viewport instead of once. */
  repeat = false,
  amount = 0.12,
  id,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: ElementType;
  repeat?: boolean;
  amount?: number;
  id?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "className" | "id">) {
  const { ref, state } = useReveal<HTMLDivElement>({ once: !repeat, amount });
  return (
    <Tag
      id={id}
      ref={ref}
      className={["fw-reveal", className].filter(Boolean).join(" ")}
      data-reveal={state}
      style={{ "--fw-delay": `${clampDelay(delay)}ms` } as React.CSSProperties}
      {...rest}
    >
      {children}
    </Tag>
  );
}
