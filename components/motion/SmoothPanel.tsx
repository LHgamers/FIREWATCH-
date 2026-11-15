"use client";

/**
 * SmoothPanel
 * -----------
 * The existing `.panel` surface with a 1 px hover lift. Presentational only:
 * it adds no data, no timers and no state. `interactive` must be true for the
 * hover transform, so static panels never move under the cursor.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import "./motion.css";

export function SmoothPanel({
  children,
  className,
  interactive = false,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      className={cn("panel", interactive && "fw-panel", className)}
      data-interactive={interactive ? "true" : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}
