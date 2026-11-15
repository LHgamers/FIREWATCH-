"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/format";
import { useTheme } from "./ThemeProvider";

/** light → dark → system → light */
const NEXT_THEME: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

/**
 * Compact 3-state theme button. Icon + system dot are driven by the attributes
 * `THEME_INIT_SCRIPT` writes on <html>, so the control is correct at first paint
 * and cannot cause a hydration mismatch; only the accessible name waits for mount.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolved, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const next = NEXT_THEME[theme];
  const label = mounted ? `Switch to ${next} theme` : "Switch colour theme";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={mounted ? `${label} (currently ${theme === "system" ? `system · ${resolved}` : theme})` : undefined}
      aria-pressed={resolved === "dark"}
      className={cn(
        "group relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-elevated/50 text-muted transition-colors",
        "hover:border-cyan/40 hover:bg-elevated hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-void",
        className,
      )}
    >
      <Sun
        size={14}
        aria-hidden
        className="hidden [html[data-theme=light]_&]:block"
      />
      <Moon
        size={14}
        aria-hidden
        className="[html[data-theme=light]_&]:hidden"
      />
      {/* "system" preference marker — the third state of the cycle */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-1 right-1 hidden h-1 w-1 rounded-full bg-cyan [html[data-theme-pref=system]_&]:block"
      />
    </button>
  );
}
