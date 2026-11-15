"use client";

/**
 * LoadingIndicator
 * ----------------
 * An honestly indeterminate indicator. There is no progress bar that pretends
 * to know how far along a request is: the engine returns one JSON payload, so
 * there is no measured fraction to show. What it does instead is state what is
 * being waited for.
 *
 *   <LoadingIndicator label="Querying /api/cells" />
 *
 * Accessibility: `role="status"` + `aria-live="polite"`, so screen readers
 * announce the label once, and the spinner is `aria-hidden` because a rotating
 * ring carries no information for a non-visual user.
 */

import { cn } from "@/lib/format";
import "./motion.css";

export function LoadingIndicator({
  label = "Waiting for the engine",
  detail,
  variant = "spinner",
  className,
  size = "md",
}: {
  label?: string;
  detail?: string;
  variant?: "spinner" | "bar" | "dots";
  className?: string;
  size?: "sm" | "md";
}) {
  const dimension = size === "sm" ? "h-3 w-3 border" : "h-4 w-4 border-2";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2 text-muted", className)}
    >
      {variant === "spinner" ? (
        <span className={cn("fw-spinner shrink-0 text-cyan", dimension)} aria-hidden />
      ) : null}
      {variant === "dots" ? (
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="fw-dot h-1 w-1 rounded-full bg-cyan"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
      ) : null}
      <span className={cn("min-w-0", size === "sm" ? "text-[10.5px]" : "text-[11.5px]")}>
        {label}
        {detail ? <span className="ml-1 font-mono text-[10px] text-muted/70">{detail}</span> : null}
      </span>
      {variant === "bar" ? (
        <span className="fw-bar ml-2 h-1 w-16 shrink-0 rounded-full" aria-hidden />
      ) : null}
    </div>
  );
}
