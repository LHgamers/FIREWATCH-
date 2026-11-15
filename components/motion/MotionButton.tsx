"use client";

/**
 * MotionButton
 * ------------
 * The existing `.btn` look plus a 1.5 % press scale and a compositor-only
 * transition. Renders a real <button>: keyboard, focus ring and disabled
 * behaviour are unchanged, and it is still a button if the CSS never loads.
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/format";
import "./motion.css";

export interface MotionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** Matches the existing button vocabulary in app/globals.css. */
  tone?: "default" | "primary" | "ghost";
  /** Optional loading flag: disables the button and shows a spinner glyph. */
  busy?: boolean;
}

export const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(function MotionButton(
  { children, className, tone = "default", busy = false, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(
        "btn fw-btn",
        tone === "primary" && "btn-primary",
        tone === "ghost" && "btn-ghost",
        className,
      )}
      {...rest}
    >
      {busy ? <span className="fw-spinner h-3 w-3 border" aria-hidden /> : null}
      {children}
    </button>
  );
});
